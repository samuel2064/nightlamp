import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { AuthContext } from '../api/auth';
import { rowBelongsToTenant, tenantFilter } from '../api/tenant';
import {
  EndpointCheckType,
  runEndpointCheck,
} from '../engine/health-check';

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
const MIN_INTERVAL_SEC = 10;
const MAX_INTERVAL_SEC = 86_400;
const MIN_TIMEOUT_SEC = 1;
const MAX_TIMEOUT_SEC = 30;

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
  return name;
}

function validateHttpUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppValidationError({ [field]: `${field} must be a non-empty URL` });
  }
  const url = value.trim();
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
  if (checkType === 'tcp') {
    if (target.startsWith('tcp://')) {
      try {
        const parsed = new URL(target);
        const port = Number(parsed.port);
        if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error('Invalid TCP target');
        }
      } catch {
        throw new AppValidationError({ checkTarget: 'checkTarget must use host:port format' });
      }
      return target;
    }
    const separator = target.lastIndexOf(':');
    const host = separator > 0 ? target.slice(0, separator) : '';
    const port = Number(separator >= 0 ? target.slice(separator + 1) : '');
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppValidationError({ checkTarget: 'checkTarget must use host:port format' });
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

export class AppsApi {
  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse, auth: AuthContext): boolean {
    const path = (new URL(req.url || '/', `http://${req.headers.host}`).pathname).replace(/\/+$/, '');
    const appMatch = path.match(/^\/api\/apps\/([^\/]+)(?:\/(test-check))?$/);

    if (path === '/api/apps') {
      if (req.method === 'GET') {
        this.handleList(res, auth.teamId);
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
      const appId = decodeURIComponent(appMatch[1]);
      if (appMatch[2] === 'test-check') {
        if (req.method !== 'POST') {
          this.send(res, 405, { error: 'Method not allowed' });
          return true;
        }
        void this.handleTestCheck(appId, res, auth);
        return true;
      }
      if (req.method === 'GET') {
        this.handleGet(appId, res, auth.teamId);
        return true;
      }
      if (req.method === 'PATCH') {
        void this.handlePatch(req, appId, res, auth);
        return true;
      }
      if (req.method === 'DELETE') {
        this.handleDelete(appId, res, auth.teamId);
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

  private handleList(res: ServerResponse, teamId: string | null): void {
    const scope = tenantFilter('team_id', teamId);
    const result = this.db.exec(
      `SELECT id, team_id, name, url, platform, check_type, check_target, check_interval_sec, check_timeout_sec, keyword, enabled, alert_channel_id, created_at, updated_at
       FROM monitored_apps WHERE ${scope.clause} ORDER BY created_at DESC`,
      scope.params,
    );
    const records = result.length > 0 ? result[0].values.map((row: any) => this.mapApp(row)) : [];
    const apps = records.map((record) => this.toResponse(record));
    this.send(res, 200, { apps, count: apps.length });
  }

  private handleGet(appId: string, res: ServerResponse, teamId: string | null): void {
    if (!rowBelongsToTenant(this.db, 'monitored_apps', appId, teamId)) {
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

      if (!rowBelongsToTenant(this.db, 'alert_channels', alertChannelId, auth.teamId)) {
        this.send(res, 404, { error: 'Alert channel not found' });
        return;
      }

      const id = uuidv4();
      this.db.run(
        `INSERT INTO monitored_apps (
          id, team_id, name, url, platform, check_type, check_target,
          check_interval_sec, check_timeout_sec, keyword, enabled, alert_channel_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          auth.teamId,
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
      if (!rowBelongsToTenant(this.db, 'monitored_apps', appId, auth.teamId)) {
        this.send(res, 404, { error: 'App not found' });
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
      if (!rowBelongsToTenant(this.db, 'alert_channels', alertChannelId, auth.teamId)) {
        this.send(res, 404, { error: 'Alert channel not found' });
        return;
      }

      updates.push("updated_at = datetime('now')");
      const scope = tenantFilter('team_id', auth.teamId);
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

  private handleDelete(appId: string, res: ServerResponse, teamId: string | null): void {
    if (!rowBelongsToTenant(this.db, 'monitored_apps', appId, teamId)) {
      this.send(res, 404, { error: 'App not found' });
      return;
    }
    const scope = tenantFilter('team_id', teamId);
    this.db.run(
      `DELETE FROM health_snapshots WHERE app_id = ? AND ${scope.clause}`,
      [appId, ...scope.params],
    );
    this.db.run(
      `DELETE FROM monitored_apps WHERE id = ? AND ${scope.clause}`,
      [appId, ...scope.params],
    );
    this.send(res, 200, { success: true });
  }

  private async handleTestCheck(appId: string, res: ServerResponse, auth: AuthContext): Promise<void> {
    if (!rowBelongsToTenant(this.db, 'monitored_apps', appId, auth.teamId)) {
      this.send(res, 404, { error: 'App not found' });
      return;
    }
    const record = this.getRecord(appId);
    if (!record) {
      this.send(res, 404, { error: 'App not found' });
      return;
    }

    const result = await runEndpointCheck({
      type: record.checkType,
      target: record.checkTarget,
      timeoutMs: record.checkTimeoutSec * 1000,
      keyword: record.keyword || undefined,
    });
    const snapshotId = uuidv4();
    const checkedAt = new Date().toISOString();
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
