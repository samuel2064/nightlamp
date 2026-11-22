import { IncomingMessage, ServerResponse } from 'http';
import { Database } from 'sql.js';
import { createHash } from 'crypto';
import { AuthContext } from '../api/auth';
import {
  ValidatedAnalyticsEvent,
  npsCategoryForScore,
  validateAnalyticsEvent,
  validateFeedbackResponse,
} from './event-contract';
import {
  feedbackPayloadMatches,
  getFeedbackResponse,
  listAnalyticsEvents,
  listFeedbackResponses,
  markAnalyticsForward,
  recordAnalyticsEvent,
  recordFeedbackResponse,
  recordFeedbackSubmission,
  type FeedbackResponseRecord,
} from './store';
import { forwardAnalyticsEvent } from './forwarder';

const MAX_BODY_BYTES = 64 * 1024;
const SCHEMA_VERSION = '1.0';

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Render a stored timestamp as the ISO 8601 form the API contract returns.
 *
 * The migration stores `received_at` with SQLite's `datetime('now')`, which is
 * `YYYY-MM-DD HH:MM:SS` and not the `T`-separated UTC form the contract defines.
 * Every timestamp that reaches a caller passes through here, so an original
 * receipt and a retried receipt cannot differ only in their shape.
 */
function normalizeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !value) return new Date().toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date(value.replace(' ', 'T') + 'Z').toISOString();
  return parsed.toISOString();
}

export class AnalyticsApi {
  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null = null): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if (path === '/api/analytics/events') {
      if (req.method === 'POST') {
        void this.ingestEvent(req, res, auth);
        return true;
      }
      if (req.method === 'GET') {
        this.listEvents(req, res, auth);
        return true;
      }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    if (path === '/api/feedback/responses') {
      if (req.method === 'POST') {
        void this.submitResponse(req, res, auth);
        return true;
      }
      if (req.method === 'GET') {
        this.listResponses(req, res, auth);
        return true;
      }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const responseMatch = path.match(/^\/api\/feedback\/responses\/([^/]+)$/);
    if (responseMatch) {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      this.getResponse(res, auth, decodeURIComponent(responseMatch[1]));
      return true;
    }

    return false;
  }

  private requireAuth(res: ServerResponse, auth: AuthContext | null): AuthContext | null {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required', code: 'UNAUTHORIZED' }));
      return null;
    }
    return auth;
  }

  /**
   * A caller without a team membership can read only the analytics it recorded
   * itself, and a caller that recorded none has no scope at all. Answer 403
   * rather than an empty list, so a caller who owns nothing is refused instead
   * of told that nothing exists anywhere.
   */
  private refuseWhenPersonalScopeEmpty(res: ServerResponse, auth: AuthContext, count: number): boolean {
    if (auth.teamId === null && count === 0) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Analytics require an organization or a recorded event', code: 'FORBIDDEN' }));
      return true;
    }
    return false;
  }

  private readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    return new Promise((resolve) => {
      let body = '';
      let size = 0;
      let settled = false;

      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413);
          res.end(JSON.stringify({ error: 'Payload too large' }));
          finish(null);
          return;
        }
        body += chunk;
      });

      req.on('end', () => finish(body));

      req.on('error', () => {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid request body' }));
        finish(null);
      });
    });
  }

  private identityProperties(auth: AuthContext): Record<string, unknown> {
    const properties: Record<string, unknown> = { user_id_hash: hashIdentifier(auth.userId) };
    if (auth.teamId) {
      properties.organization_id_hash = hashIdentifier(auth.teamId);
    }
    return properties;
  }

  private async ingestEvent(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext | null,
  ): Promise<void> {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const raw = await this.readBody(req, res);
    if (raw === null) return;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const validation = validateAnalyticsEvent(payload);
    if (!validation.ok || !validation.event) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid analytics event', errors: validation.errors }));
      return;
    }

    const properties = { ...validation.event.properties };
    delete properties.user_id_hash;
    delete properties.organization_id_hash;
    Object.assign(properties, this.identityProperties(caller));

    const stored = recordAnalyticsEvent(this.db, {
      teamId: caller.teamId,
      userId: caller.userId,
      event: validation.event,
      properties,
    });

    if (!stored.inserted) {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        accepted: true,
        duplicate: true,
        event_id: validation.event.event_id,
        event: validation.event.event,
      }));
      return;
    }

    const forwardStatus = await this.forwardStoredEvent(caller, validation.event, properties);

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      accepted: true,
      duplicate: false,
      event_id: validation.event.event_id,
      event: validation.event.event,
      forward_status: forwardStatus,
    }));
  }

  private async forwardStoredEvent(
    auth: AuthContext,
    event: ValidatedAnalyticsEvent,
    properties: Record<string, unknown>,
  ): Promise<string> {
    const outcome = await forwardAnalyticsEvent({
      event: event.event,
      event_id: event.event_id,
      schema_version: event.schema_version,
      timestamp: event.timestamp,
      distinct_id: String(properties.user_id_hash || ''),
      properties,
    });

    markAnalyticsForward(this.db, auth.teamId, event.event_id, auth.userId, {
      forwarded: outcome.forwarded,
      error: outcome.error,
    }, auth.userId);

    return outcome.status;
  }

  private listEvents(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null): void {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const requestedLimit = Number(parsedUrl.searchParams.get('limit') || '100');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;

    const items = listAnalyticsEvents(this.db, caller.teamId, limit, caller.userId);
    if (this.refuseWhenPersonalScopeEmpty(res, caller, items.length)) return;
    res.writeHead(200);
    res.end(JSON.stringify({ items, count: items.length }));
  }

  private async submitResponse(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext | null,
  ): Promise<void> {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const raw = await this.readBody(req, res);
    if (raw === null) return;

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    const validation = validateFeedbackResponse(payload);
    if (!validation.ok || !validation.value) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid feedback response', errors: validation.errors }));
      return;
    }

    const value = validation.value;
    const eventName = value.kind === 'survey' ? 'survey_completed' : 'feedback_submitted';
    const eventId = value.response_id;

    const existing = getFeedbackResponse(this.db, caller.teamId, value.response_id, caller.userId);
    if (existing) {
      if (!feedbackPayloadMatches(existing, value)) {
        res.writeHead(409);
        res.end(JSON.stringify({
          error: 'response_id was already used with a different payload',
          code: 'CONFLICT',
        }));
        return;
      }

res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      duplicate: true,
      response_id: existing.response_id,
      event_id: existing.event_id,
      event: existing.kind === 'survey' ? 'survey_completed' : 'feedback_submitted',
      received_at: normalizeTimestamp(existing.received_at),
    }));
    return;
    }

    const eventProperties: Record<string, unknown> = { response_id: eventId };
    if (value.kind === 'survey') {
      eventProperties.survey_id = value.survey_id;
      if (value.score !== undefined) {
        eventProperties.score = value.score;
        if (value.survey_id === 'nps_day14' || value.survey_id === 'nps_day30') {
          eventProperties.nps_category = npsCategoryForScore(value.score);
        }
      }
    } else {
      eventProperties.feedback_type = value.feedback_type;
    }
    Object.assign(eventProperties, this.identityProperties(caller));

    const receivedAt = new Date().toISOString();

    const event: ValidatedAnalyticsEvent = {
      event: eventName,
      event_id: eventId,
      schema_version: SCHEMA_VERSION,
      timestamp: receivedAt,
      properties: eventProperties,
    };

    let record: { inserted: boolean; record: FeedbackResponseRecord } | null = null;
    try {
      record = recordFeedbackSubmission(this.db, {
        teamId: caller.teamId,
        userId: caller.userId,
        response: value,
        event,
        properties: eventProperties,
        receivedAt,
      });
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to record feedback response' }));
      return;
    }

    const forwardStatus = await this.forwardStoredEvent(caller, event, eventProperties);

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      duplicate: false,
      response_id: value.response_id,
      event_id: eventId,
      event: eventName,
      received_at: record.record.received_at,
      forward_status: forwardStatus,
    }));
  }

  private listResponses(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null): void {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const requestedLimit = Number(parsedUrl.searchParams.get('limit') || '50');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;

    const items = listFeedbackResponses(this.db, caller.teamId, limit, caller.userId);
    if (this.refuseWhenPersonalScopeEmpty(res, caller, items.length)) return;
    res.writeHead(200);
    res.end(JSON.stringify({ items, count: items.length }));
  }

  private getResponse(res: ServerResponse, auth: AuthContext | null, responseId: string): void {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const record = getFeedbackResponse(this.db, caller.teamId, responseId, caller.userId);
    if (!record) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Response not found' }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ item: record }));
  }
}
