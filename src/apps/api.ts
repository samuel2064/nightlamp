import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { AuthContext } from '../api/auth';
import { rowBelongsToScope, scopedTenantFilter, tenantFilter } from '../api/tenant';
import {
  EndpointCheckConfig,
  EndpointCheckDeps,
  EndpointCheckResult,
  EndpointCheckType,
  assertTargetAllowed,
  parseTcpTarget,
  runEndpointCheck,
} from '../engine/health-check';
import { BlockedTargetError, TargetResolutionError } from '../engine/outbound-safety';

export const SUPPORTED_PLATFORMS = [
  'vercel',
  'railway',
  'heroku',
  'aws',
  'gcp',
  'azure',
  'custom',
] as const;

export const SUPPORTED_CHECK_TYPES: EndpointCheckType[] = ['http', 'tcp', 'keyword'];

const MAX_NAME_LENGTH = 120;
const MAX_KEYWORD_LENGTH = 256;
const MAX_BODY_LENGTH = 1_000_000;
const MAX_URL_LENGTH = 2048;
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 86_400;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 30;
const DEFAULT_COOLDOWN_MS = 5_000;
const MAX_TENANT_IN_FLIGHT = 10;
const MAX_SNAPSHOTS_PER_APP = 100;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type AppPlatform = typeof SUPPORTED_PLATFORMS[number];

interface AppRecord {
  id: string;
  teamId: string | null;
  name: string;
  url: string;
  platform: AppPlatform;
  checkType: EndpointCheckType;
  checkTarget: string;
  checkIntervalSec: number;
  checkTimeoutSec: number;
  keyword: string | null;
  enabled: boolean;
  alertChannelId: string;
  createdAt: string;
  updatedAt: string;
}

class AppValidationError extends Error {
  constructor(public readonly fields: Record<string, string>) {
    super('Validation failed');
    this.name = 'AppValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppValidationError({ name: 'name must be a non-empty string' });
  }
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH) {
    throw new AppValidationError({ name: `name must be at most ${MAX_NAME_LENGTH} characters` });
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new AppValidationError({ name: 'name must not contain control characters' });
  }
  return name;
}

function validateHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppValidationError({ [field]: `${field} must be a non-empty URL` });
  }
  const url = value.trim();
  if (url.length > MAX_URL_LENGTH) {
    throw new AppValidationError({ [field]: `${field} must be at most ${MAX_URL_LENGTH} characters` });
  }
  if (/\s/.test(url)) {
    throw new AppValidationError({ [field]: `${field} must not contain whitespace` });
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppValidationError({ [field]: `${field} must be a valid URL` });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppValidationError({ [field]: `${field} must use http or https` });
  }
  if (parsed.username || parsed.password) {
    throw new AppValidationError({ [field]: `${field} must not contain embedded credentials` });
  }
  if (!parsed.hostname) {
    throw new AppValidationError({ [field]: `${field} must include a hostname` });
  }
  return url;
}

function validatePlatform(value: unknown): AppPlatform {
  if (typeof value !== 'string' || !SUPPORTED_PLATFORMS.includes(value as AppPlatform)) {
    throw new AppValidationError({
      platform: `platform must be one of: ${SUPPORTED_PLATFORMS.join(', ')}`,
    });
  }
  return value as AppPlatform;
}

function validateCheckType(value: unknown): EndpointCheckType {
  if (typeof value !== 'string' || !SUPPORTED_CHECK_TYPES.includes(value as EndpointCheckType)) {
    throw new AppValidationError({
      checkType: `checkType must be one of: ${SUPPORTED_CHECK_TYPES.join(', ')}`,
    });
  }
  return value as EndpointCheckType;
}

function validateInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppValidationError({
      [field]: `${field} must be an integer between ${minimum} and ${maximum}`,
    });
  }
  return parsed;
}

function validateEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new AppValidationError({ enabled: 'enabled must be a boolean' });
  }
  return value;
}

function validateKeyword(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppValidationError({ keyword: 'keyword must be a non-empty string' });
  }
  const keyword = value.trim();
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    throw new AppValidationError({ keyword: `keyword must be at most ${MAX_KEYWORD_LENGTH} characters` });
  }
  return keyword;
}

function validateCheckTarget(value: unknown, checkType: EndpointCheckType): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppValidationError({ checkTarget: 'checkTarget must be a non-empty string' });
  }
  const target = value.trim();
  if (target.length > MAX_URL_LENGTH) {
    throw new AppValidationError({ checkTarget: `checkTarget must be at most ${MAX_URL_LENGTH} characters` });
  }
  if (/\s/.test(target)) {
    throw new AppValidationError({ checkTarget: 'checkTarget must not contain whitespace' });
  }
  if (checkType === 'tcp') {
    if (target.includes('@')) {
      throw new AppValidationError({ checkTarget: 'checkTarget must not contain credentials' });
    }
    if (target.startsWith('tcp://')) {
      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        throw new AppValidationError({ checkTarget: 'checkTarget must use host:port format' });
      }
      if (parsed.username || parsed.password) {
        throw new AppValidationError({ checkTarget: 'checkTarget must not contain credentials' });
      }
      if (parsed.pathname && parsed.pathname !== '/') {
        throw new AppValidationError({ checkTarget: 'checkTarget must not contain a path' });
      }
      if (parsed.search || parsed.hash) {
        throw new AppValidationError({ checkTarget: 'checkTarget must not contain a query or fragment' });
      }
    } else if (target.includes('/')) {
      throw new AppValidationError({ checkTarget: 'checkTarget must use host:port format' });
    }
    const parsedTarget = parseTcpTarget(target);
    if (!parsedTarget || !parsedTarget.host) {
      throw new AppValidationError({ checkTarget: 'checkTarget must use host:port format' });
    }
    if (!/^[A-Za-z0-9._-]+$/.test(parsedTarget.host) && !/^[0-9A-Fa-f:.]+$/.test(parsedTarget.host)) {
      throw new AppValidationError({ checkTarget: 'checkTarget host is not valid' });
    }
    return target;
  }
  return validateHttpUrl(target, 'checkTarget');
}

function validateAlertChannelId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppValidationError({ alertChannelId: 'alertChannelId must reference an alert channel' });
  }
  return value.trim();
}

function validationError(fields: Record<string, string>): AppValidationError {
  return new AppValidationError(fields);
}

export interface AppsApiDeps {
  assertTargetAllowed?: (target: string, checkType: EndpointCheckType) => Promise<void>;
  runCheck?: (config: EndpointCheckConfig) => Promise<EndpointCheckResult>;
  endpointDeps?: EndpointCheckDeps;
  cooldownMs?: number;
  now?: () => number;
}

export class AppsApi {
  private readonly inFlightApps = new Set<string>();
  private readonly inFlightScopes = new Map<string, string>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly inFlightPreviews = new Set<string>();
  private readonly lastPreviewAt = new Map<string, number>();

  constructor(private db: Database, private deps: AppsApiDeps = {}) {}

  handle(req: IncomingMessage, res: ServerResponse, auth: AuthContext): boolean {
    const path = (new URL(req.url || '/', `http://${req.headers.host}`).pathname).replace(/\/+$/, '');
    const appMatch = path.match(/^\/api\/apps\/([^\/]+)(?:\/(test-check))?$/);

    if (path === '/api/apps/test-check') {
      if (req.method !== 'POST') {
        this.send(res, 405, { error: 'Method not allowed' });
        return true;
      }
      void this.handlePreviewCheck(req, res, auth);
      return true;
    }

    if (path === '/api/apps') {
      if (req.method === 'GET') {
        this.handleList(res, auth);
        return true;
      }
      if (req.method === 'POST') {
        void this.handleCreate(req, res, auth);
        return true;
      }
      this.send(res, 405, { error: 'Method not allowed' });
      return true;
    }

    if (appMatch) {
      let appId: string;
      try {
        appId = decodeURIComponent(appMatch[1]);
      } catch {
        this.send(res, 400, { error: 'Invalid app id' });
        return true;
      }
      if (appMatch[2] === 'test-check') {
        if (req.method !== 'POST') {
          this.send(res, 405, { error: 'Method not allowed' });
          return true;
        }
        void this.handleTestCheck(appId, res, auth);
        return true;
      }
      if (req.method === 'GET') {
        this.handleGet(appId, res, auth);
        return true;
      }
      if (req.method === 'PATCH') {
        void this.handlePatch(req, appId, res, auth);
        return true;
      }
      if (req.method === 'DELETE') {
        this.handleDelete(appId, res, auth);
        return true;
      }
      this.send(res, 405, { error: 'Method not allowed' });
      return true;
    }

    return false;
  }

  private send(res: ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode);
    res.end(JSON.stringify(payload));
  }

  private async readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk.toString();
      if (raw.length > MAX_BODY_LENGTH) {
        throw validationError({ body: 'request body is too large' });
      }
    }
    if (raw.trim().length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw validationError({ body: 'request body must be valid JSON' });
    }
    if (!isRecord(parsed)) {
      throw validationError({ body: 'request body must be a JSON object' });
    }
    return parsed;
  }

  private handleList(res: ServerResponse, auth: AuthContext): void {
    const scope = scopedTenantFilter('monitored_apps', auth.teamId, auth.userId, true);
    const result = this.db.exec(
      `SELECT id, team_id, name, url, platform, check_type, check_target, check_interval_sec, check_timeout_sec, keyword, enabled, alert_channel_id, created_at, updated_at
       FROM monitored_apps WHERE ${scope.clause} ORDER BY created_at DESC`,
      scope.params,
    );
    const records = result.length > 0 ? result[0].values.map((row: any) => this.mapApp(row)) : [];
    const apps = records.map((record) => this.toResponse(record));
    this.send(res, 200, { apps, count: apps.length });
  }

  private handleGet(appId: string, res: ServerResponse, auth: AuthContext): void {
    if (!this.appInScope(auth, appId)) {
      this.send(res, 404, { error: 'App not found' });
      return;
    }
    const record = this.getRecord(appId);
    if (!record) {
      this.send(res, 404, { error: 'App not found' });
      return;
    }
    this.send(res, 200, { app: this.toResponse(record) });
  }

  private async handleCreate(req: IncomingMessage, res: ServerResponse, auth: AuthContext): Promise<void> {
    try {
      if (!auth.teamId) {
        this.send(res, 403, { error: 'Applications require an organization' });
        return;
      }
      const body = await this.readBody(req);
      if (hasOwn(body, 'teamId') && body.teamId !== auth.teamId) {
        this.send(res, 403, { error: 'Cannot create an application for another organization' });
        return;
      }

      const name = validateName(body.name === undefined ? body.appName : body.name);
      const url = validateHttpUrl(body.url === undefined ? body.appUrl : body.url, 'url');
      const platform = validatePlatform(body.platform);
      const checkType = validateCheckType(body.checkType === undefined ? 'http' : body.checkType);
      const requestedCheckTarget = body.checkTarget === undefined ? body.checkUrl : body.checkTarget;
      const checkTargetValue = requestedCheckTarget === undefined && checkType !== 'tcp'
        ? url
        : requestedCheckTarget;
      const checkTarget = validateCheckTarget(checkTargetValue, checkType);
      const requestedInterval = body.checkIntervalSec === undefined
        ? body.checkInterval === undefined
          ? body.interval
          : body.checkInterval
        : body.checkIntervalSec;
      const checkIntervalSec = validateInteger(
        requestedInterval === undefined ? 60 : requestedInterval,
        'checkIntervalSec',
        MIN_INTERVAL_SEC,
        MAX_INTERVAL_SEC,
      );
      const checkTimeoutSec = validateInteger(
        body.checkTimeoutSec === undefined ? body.timeout === undefined ? 10 : body.timeout : body.checkTimeoutSec,
        'checkTimeoutSec',
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC,
      );
      const keyword = body.keyword === undefined
        ? null
        : validateKeyword(body.keyword);
      if (checkType === 'keyword' && !keyword) {
        throw validationError({ keyword: 'keyword is required for keyword checks' });
      }
      const enabled = body.enabled === undefined ? true : validateEnabled(body.enabled);
      const alertChannelId = validateAlertChannelId(
        body.alertChannelId === undefined ? body.channelId : body.alertChannelId,
      );

      await this.assertTargetAllowed(checkTarget, checkType);

      if (!rowBelongsToScope(this.db, 'alert_channels', alertChannelId, auth.teamId, auth.userId, true)) {
        this.send(res, 404, { error: 'Alert channel not found' });
        return;
      }

      const id = uuidv4();
      this.withForeignKeys(() => {
        this.db.run(
          `INSERT INTO monitored_apps (
            id, team_id, owner_id, name, url, platform, check_type, check_target,
            check_interval_sec, check_timeout_sec, keyword, enabled, alert_channel_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            auth.teamId,
            auth.userId,
            name,
            url,
            platform,
            checkType,
            checkTarget,
            checkIntervalSec,
            checkTimeoutSec,
            keyword,
            enabled ? 1 : 0,
            alertChannelId,
          ],
        );
      });
      const record = this.getRecord(id);
      this.send(res, 201, { app: record ? this.toResponse(record) : null });
    } catch (error) {
      if (error instanceof AppValidationError) {
        this.send(res, 400, { error: error.message, fields: error.fields });
        return;
      }
      this.send(res, 500, { error: error instanceof Error ? error.message : 'Failed to create app' });
    }
  }

  private async handlePatch(
    req: IncomingMessage,
    appId: string,
    res: ServerResponse,
    auth: AuthContext,
  ): Promise<void> {
    try {
      if (!this.assertMutable(auth, appId, res)) {
        return;
      }
      const current = this.getRecord(appId);
      if (!current) {
        this.send(res, 404, { error: 'App not found' });
        return;
      }
      const body = await this.readBody(req);
      if (hasOwn(body, 'teamId') && body.teamId !== current.teamId) {
        this.send(res, 403, { error: 'Cannot move an application to another organization' });
        return;
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      let name = current.name;
      let url = current.url;
      let platform = current.platform;
      let checkType = current.checkType;
      let checkTarget = current.checkTarget;
      let checkIntervalSec = current.checkIntervalSec;
      let checkTimeoutSec = current.checkTimeoutSec;
      let keyword = current.keyword;
      let enabled = current.enabled;
      let alertChannelId = current.alertChannelId;

      if (hasOwn(body, 'name') || hasOwn(body, 'appName')) {
        name = validateName(body.name === undefined ? body.appName : body.name);
        updates.push('name = ?');
        params.push(name);
      }
      if (hasOwn(body, 'url') || hasOwn(body, 'appUrl')) {
        url = validateHttpUrl(body.url === undefined ? body.appUrl : body.url, 'url');
        updates.push('url = ?');
        params.push(url);
      }
      if (hasOwn(body, 'platform')) {
        platform = validatePlatform(body.platform);
        updates.push('platform = ?');
        params.push(platform);
      }
      if (hasOwn(body, 'checkType')) {
        checkType = validateCheckType(body.checkType);
        updates.push('check_type = ?');
        params.push(checkType);
      }
      if (hasOwn(body, 'checkTarget') || hasOwn(body, 'checkUrl')) {
        checkTarget = validateCheckTarget(
          body.checkTarget === undefined ? body.checkUrl : body.checkTarget,
          checkType,
        );
        updates.push('check_target = ?');
        params.push(checkTarget);
      }
      if (hasOwn(body, 'checkIntervalSec')) {
        checkIntervalSec = validateInteger(body.checkIntervalSec, 'checkIntervalSec', MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
        updates.push('check_interval_sec = ?');
        params.push(checkIntervalSec);
      } else if (hasOwn(body, 'checkInterval')) {
        checkIntervalSec = validateInteger(body.checkInterval, 'checkIntervalSec', MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
        updates.push('check_interval_sec = ?');
        params.push(checkIntervalSec);
      } else if (hasOwn(body, 'interval')) {
        checkIntervalSec = validateInteger(body.interval, 'checkIntervalSec', MIN_INTERVAL_SEC, MAX_INTERVAL_SEC);
        updates.push('check_interval_sec = ?');
        params.push(checkIntervalSec);
      }
      if (hasOwn(body, 'checkTimeoutSec')) {
        checkTimeoutSec = validateInteger(body.checkTimeoutSec, 'checkTimeoutSec', MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
        updates.push('check_timeout_sec = ?');
        params.push(checkTimeoutSec);
      } else if (hasOwn(body, 'timeout')) {
        checkTimeoutSec = validateInteger(body.timeout, 'checkTimeoutSec', MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC);
        updates.push('check_timeout_sec = ?');
        params.push(checkTimeoutSec);
      }
      if (hasOwn(body, 'keyword')) {
        keyword = validateKeyword(body.keyword);
        updates.push('keyword = ?');
        params.push(keyword);
      }
      if (hasOwn(body, 'enabled')) {
        enabled = validateEnabled(body.enabled);
        updates.push('enabled = ?');
        params.push(enabled ? 1 : 0);
      }
      if (hasOwn(body, 'alertChannelId')) {
        alertChannelId = validateAlertChannelId(body.alertChannelId);
        updates.push('alert_channel_id = ?');
        params.push(alertChannelId);
      } else if (hasOwn(body, 'channelId')) {
        alertChannelId = validateAlertChannelId(body.channelId);
        updates.push('alert_channel_id = ?');
        params.push(alertChannelId);
      }

      if (updates.length === 0) {
        throw validationError({ body: 'No fields to update' });
      }
      if (checkType === 'keyword' && !keyword) {
        throw validationError({ keyword: 'keyword is required for keyword checks' });
      }
      checkTarget = validateCheckTarget(checkTarget, checkType);
      await this.assertTargetAllowed(checkTarget, checkType);
      if (!rowBelongsToScope(this.db, 'alert_channels', alertChannelId, auth.teamId, auth.userId, true)) {
        this.send(res, 404, { error: 'Alert channel not found' });
        return;
      }

      updates.push("updated_at = datetime('now')");
const scope = scopedTenantFilter('monitored_apps', auth.teamId, auth.userId, false);
      this.db.run(
        `UPDATE monitored_apps SET ${updates.join(', ')} WHERE id = ? AND ${scope.clause}`,
        [...params, appId, ...scope.params],
      );
      const record = this.getRecord(appId);
      this.send(res, 200, { app: record ? this.toResponse(record) : null });
    } catch (error) {
      if (error instanceof AppValidationError) {
        this.send(res, 400, { error: error.message, fields: error.fields });
        return;
      }
      this.send(res, 500, { error: error instanceof Error ? error.message : 'Failed to update app' });
    }
  }

  private handleDelete(appId: string, res: ServerResponse, auth: AuthContext): void {
    if (!this.assertMutable(auth, appId, res)) {
      return;
    }
    const scope = scopedTenantFilter('monitored_apps', auth.teamId, auth.userId, false);
    const snapshotScope = tenantFilter('team_id', auth.teamId);
    this.withForeignKeys(() => {
      this.db.run(
        `DELETE FROM health_snapshots WHERE app_id = ? AND ${snapshotScope.clause}`,
        [appId, ...snapshotScope.params],
      );
      this.db.run(
        `DELETE FROM monitored_apps WHERE id = ? AND ${scope.clause}`,
        [appId, ...scope.params],
      );
    });
    this.send(res, 200, { success: true });
  }

  private async handleTestCheck(appId: string, res: ServerResponse, auth: AuthContext): Promise<void> {
    if (!this.assertMutable(auth, appId, res)) {
      return;
    }
    const record = this.getRecord(appId);
    if (!record) {
      this.send(res, 404, { error: 'App not found' });
      return;
    }

    const scopeKey = auth.teamId || `personal:${auth.userId}`;
    const cooldownMs = this.deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    const now = this.currentTime();

    if (this.inFlightApps.has(appId)) {
      this.sendTooManyRequests(res, 'A check is already running for this app', cooldownMs);
      return;
    }

    let scopeInFlight = 0;
    for (const scope of this.inFlightScopes.values()) {
      if (scope === scopeKey) scopeInFlight += 1;
    }
    if (scopeInFlight >= MAX_TENANT_IN_FLIGHT) {
      this.sendTooManyRequests(res, 'Too many checks are already running for this organization', cooldownMs);
      return;
    }

    const lastRun = this.lastRunAt.get(appId);
    if (lastRun !== undefined && cooldownMs > 0) {
      const elapsed = now - lastRun;
      if (elapsed < cooldownMs) {
        this.sendTooManyRequests(res, 'Please wait before running another check for this app', cooldownMs - elapsed);
        return;
      }
    }

    this.inFlightApps.add(appId);
    this.inFlightScopes.set(appId, scopeKey);

    try {
      const result = await this.runCheck(record);
      const snapshotId = uuidv4();
      const checkedAt = new Date().toISOString();
      this.withForeignKeys(() => {
        this.db.run(
          `INSERT INTO health_snapshots (
            id, app_id, team_id, status, status_code, latency_ms, error_type, error_detail, checked_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshotId,
            appId,
            record.teamId,
            result.status,
            result.statusCode,
            result.latencyMs,
            result.errorType,
            result.errorDetail,
            checkedAt,
          ],
        );
      });
      this.pruneSnapshots(appId, record.teamId);
      this.send(res, 200, {
        result: {
          id: snapshotId,
          appId,
          status: result.status,
          statusCode: result.statusCode,
          latencyMs: result.latencyMs,
          errorType: result.errorType,
          errorDetail: result.errorDetail,
          checkedAt,
        },
      });
    } finally {
      this.inFlightApps.delete(appId);
      this.inFlightScopes.delete(appId);
      this.lastRunAt.set(appId, this.currentTime());
    }
  }

  private currentTime(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /**
   * Run a write with foreign key enforcement enabled.
   *
   * The monitored app tables declare their references, so the insert must fail
   * when the channel or application row is missing. Enforcement is toggled per
   * statement batch because the legacy tables intentionally keep their existing
   * (unenforced) behaviour.
   */
  private withForeignKeys<T>(action: () => T): T {
    this.db.run('PRAGMA foreign_keys = ON');
    try {
      return action();
    } finally {
      this.db.run('PRAGMA foreign_keys = OFF');
    }
  }

  private appInScope(auth: AuthContext, appId: string): boolean {
    return rowBelongsToScope(this.db, 'monitored_apps', appId, auth.teamId, auth.userId, true);
  }

  private assertMutable(auth: AuthContext, appId: string, res: ServerResponse): boolean {
    if (this.appInScope(auth, appId)) {
      return true;
    }
    this.send(res, 404, { error: 'App not found' });
    return false;
  }

  /**
   * Run an ad-hoc check against a target without creating a monitored app.
   *
   * The Add App flow validates the target before the app exists, so this
   * endpoint exists to give that flow a real backend call. It applies the same
   * outbound safety policy and the same tenant level in-flight and cooldown
   * limits as the per-app test check, and it never writes to the database.
   */
  private async handlePreviewCheck(req: IncomingMessage, res: ServerResponse, auth: AuthContext): Promise<void> {
    try {
      if (!auth.teamId) {
        this.send(res, 403, { error: 'Applications require an organization' });
        return;
      }
      const body = await this.readBody(req);
      const checkType = validateCheckType(body.checkType === undefined ? 'http' : body.checkType);
      const requestedTarget = body.checkTarget === undefined
        ? body.checkUrl === undefined
          ? body.url
          : body.checkUrl
        : body.checkTarget;
      if (requestedTarget === undefined) {
        throw validationError({ checkTarget: 'checkTarget must be a non-empty string' });
      }
      const checkTarget = validateCheckTarget(requestedTarget, checkType);
      const checkTimeoutSec = validateInteger(
        body.checkTimeoutSec === undefined
          ? body.timeout === undefined ? 10 : body.timeout
          : body.checkTimeoutSec,
        'checkTimeoutSec',
        MIN_TIMEOUT_SEC,
        MAX_TIMEOUT_SEC,
      );
      const keyword = body.keyword === undefined ? null : validateKeyword(body.keyword);
      if (checkType === 'keyword' && !keyword) {
        throw validationError({ keyword: 'keyword is required for keyword checks' });
      }

      const scopeKey = auth.teamId || `personal:${auth.userId}`;
      const cooldownMs = this.deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
      const now = this.currentTime();
      const previewKey = `${scopeKey}:${checkType}:${checkTarget}`;

      if (this.inFlightPreviews.has(previewKey)) {
        this.sendTooManyRequests(res, 'A check is already running for this target', cooldownMs);
        return;
      }
      if (this.previewScopeCount(scopeKey) >= MAX_TENANT_IN_FLIGHT) {
        this.sendTooManyRequests(res, 'Too many checks are already running for this organization', cooldownMs);
        return;
      }
      const lastRun = this.lastPreviewAt.get(previewKey);
      if (lastRun !== undefined && cooldownMs > 0) {
        const elapsed = now - lastRun;
        if (elapsed < cooldownMs) {
          this.sendTooManyRequests(res, 'Please wait before running another check for this target', cooldownMs - elapsed);
          return;
        }
      }

      this.inFlightPreviews.add(previewKey);
      try {
        await this.assertTargetAllowed(checkTarget, checkType);
        const result = await this.runCheckConfig({
          type: checkType,
          target: checkTarget,
          timeoutMs: checkTimeoutSec * 1000,
          keyword: keyword || undefined,
        });
        this.send(res, 200, {
          result: {
            status: result.status,
            statusCode: result.statusCode,
            latencyMs: result.latencyMs,
            errorType: result.errorType,
            errorDetail: result.errorDetail,
            checkedAt: new Date().toISOString(),
          },
        });
      } finally {
        this.inFlightPreviews.delete(previewKey);
        this.lastPreviewAt.set(previewKey, this.currentTime());
      }
    } catch (error) {
      if (error instanceof AppValidationError) {
        this.send(res, 400, { error: error.message, fields: error.fields });
        return;
      }
      this.send(res, 500, { error: error instanceof Error ? error.message : 'Failed to run check' });
    }
  }

  private previewScopeCount(scopeKey: string): number {
    let count = 0;
    for (const key of this.inFlightPreviews.keys()) {
      if (key.startsWith(`${scopeKey}:`)) count += 1;
    }
    return count;
  }

  private async runCheck(record: AppRecord): Promise<EndpointCheckResult> {
    return this.runCheckConfig({
      type: record.checkType,
      target: record.checkTarget,
      timeoutMs: record.checkTimeoutSec * 1000,
      keyword: record.keyword || undefined,
    });
  }

  private async runCheckConfig(config: EndpointCheckConfig): Promise<EndpointCheckResult> {
    if (this.deps.runCheck) {
      return this.deps.runCheck(config);
    }
    return runEndpointCheck(config, this.deps.endpointDeps);
  }

  private async assertTargetAllowed(target: string, checkType: EndpointCheckType): Promise<void> {
    const checker = this.deps.assertTargetAllowed
      || ((value: string, type: EndpointCheckType) => assertTargetAllowed(value, type, this.deps.endpointDeps));
    try {
      await checker(target, checkType);
    } catch (error) {
      if (error instanceof BlockedTargetError || error instanceof TargetResolutionError) {
        throw validationError({ checkTarget: error.message });
      }
      throw error;
    }
  }

  private pruneSnapshots(appId: string, teamId: string | null): void {
    this.db.run(
      `DELETE FROM health_snapshots
       WHERE app_id = ? AND team_id IS ?
         AND id NOT IN (
           SELECT id FROM health_snapshots
           WHERE app_id = ? AND team_id IS ?
           ORDER BY checked_at DESC, id DESC
           LIMIT ?
         )`,
      [appId, teamId, appId, teamId, MAX_SNAPSHOTS_PER_APP],
    );
  }

  private sendTooManyRequests(res: ServerResponse, message: string, retryAfterMs: number): void {
    const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    this.send(res, 429, { error: message, retryAfterSec });
  }

  private getRecord(appId: string): AppRecord | null {
    const result = this.db.exec(
      `SELECT id, team_id, name, url, platform, check_type, check_target, check_interval_sec, check_timeout_sec, keyword, enabled, alert_channel_id, created_at, updated_at
       FROM monitored_apps WHERE id = ?`,
      [appId],
    );
    return result.length > 0 && result[0].values.length > 0
      ? this.mapApp(result[0].values[0])
      : null;
  }

  private mapApp(row: any): AppRecord {
    return {
      id: row[0],
      teamId: row[1] === null ? null : String(row[1]),
      name: row[2],
      url: row[3],
      platform: row[4],
      checkType: row[5],
      checkTarget: row[6],
      checkIntervalSec: row[7],
      checkTimeoutSec: row[8],
      keyword: row[9] === null ? null : row[9],
      enabled: row[10] === 1,
      alertChannelId: row[11],
      createdAt: row[12],
      updatedAt: row[13],
    };
  }

  private toResponse(record: AppRecord): Record<string, unknown> {
    const scope = tenantFilter('team_id', record.teamId);
    const channelResult = this.db.exec(
      `SELECT id, name, type, enabled FROM alert_channels WHERE id = ? AND ${scope.clause}`,
      [record.alertChannelId, ...scope.params],
    );
    const channel = channelResult.length > 0 && channelResult[0].values.length > 0
      ? {
          id: channelResult[0].values[0][0],
          name: channelResult[0].values[0][1],
          type: channelResult[0].values[0][2],
          enabled: channelResult[0].values[0][3] === 1,
        }
      : null;

    const snapshotResult = this.db.exec(
      `SELECT id, app_id, status, status_code, latency_ms, error_type, error_detail, checked_at
       FROM health_snapshots WHERE app_id = ? AND ${scope.clause}
       ORDER BY checked_at DESC LIMIT 1`,
      [record.id, ...scope.params],
    );
    const latestHealth = snapshotResult.length > 0 && snapshotResult[0].values.length > 0
      ? {
          id: snapshotResult[0].values[0][0],
          appId: snapshotResult[0].values[0][1],
          status: snapshotResult[0].values[0][2],
          statusCode: snapshotResult[0].values[0][3] === null ? null : snapshotResult[0].values[0][3],
          latencyMs: snapshotResult[0].values[0][4],
          errorType: snapshotResult[0].values[0][5] === null ? null : snapshotResult[0].values[0][5],
          errorDetail: snapshotResult[0].values[0][6] === null ? null : snapshotResult[0].values[0][6],
          checkedAt: snapshotResult[0].values[0][7],
        }
      : null;

    return {
      id: record.id,
      teamId: record.teamId,
      name: record.name,
      url: record.url,
      platform: record.platform,
      checkType: record.checkType,
      checkTarget: record.checkTarget,
      checkUrl: record.checkTarget,
      checkIntervalSec: record.checkIntervalSec,
      checkInterval: record.checkIntervalSec,
      interval: record.checkIntervalSec,
      checkTimeoutSec: record.checkTimeoutSec,
      timeout: record.checkTimeoutSec,
      keyword: record.keyword,
      enabled: record.enabled,
      alertChannelId: record.alertChannelId,
      alertChannel: channel,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      latestHealth,
    };
  }
}
