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
  getFeedbackResponse,
  listAnalyticsEvents,
  listFeedbackResponses,
  markAnalyticsForward,
  recordAnalyticsEvent,
  recordFeedbackResponse,
} from './store';
import { forwardAnalyticsEvent } from './forwarder';

const MAX_BODY_BYTES = 64 * 1024;
const SCHEMA_VERSION = '1.0';

function hashIdentifier(value: string): string {
  return createHash('sha256').update(value).digest('hex');
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

    markAnalyticsForward(this.db, auth.teamId, event.event_id, {
      forwarded: outcome.forwarded,
      error: outcome.error,
    });

    return outcome.status;
  }

  private listEvents(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null): void {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const requestedLimit = Number(parsedUrl.searchParams.get('limit') || '100');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 500) : 100;

    const items = listAnalyticsEvents(this.db, caller.teamId, limit);
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

    const stored = recordFeedbackResponse(this.db, {
      teamId: caller.teamId,
      userId: caller.userId,
      response: value,
      eventId,
    });

    if (!stored.inserted) {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        duplicate: true,
        response_id: stored.record.response_id,
        event_id: stored.record.event_id,
        event: stored.record.kind === 'survey' ? 'survey_completed' : 'feedback_submitted',
        received_at: stored.record.received_at,
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

    const event: ValidatedAnalyticsEvent = {
      event: eventName,
      event_id: eventId,
      schema_version: SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      properties: eventProperties,
    };

    recordAnalyticsEvent(this.db, {
      teamId: caller.teamId,
      userId: caller.userId,
      event,
      properties: eventProperties,
    });

    const forwardStatus = await this.forwardStoredEvent(caller, event, eventProperties);

    res.writeHead(200);
    res.end(JSON.stringify({
      success: true,
      duplicate: false,
      response_id: stored.record.response_id,
      event_id: eventId,
      event: eventName,
      received_at: stored.record.received_at,
      forward_status: forwardStatus,
    }));
  }

  private listResponses(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null): void {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const requestedLimit = Number(parsedUrl.searchParams.get('limit') || '50');
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 200) : 50;

    const items = listFeedbackResponses(this.db, caller.teamId, limit);
    res.writeHead(200);
    res.end(JSON.stringify({ items, count: items.length }));
  }

  private getResponse(res: ServerResponse, auth: AuthContext | null, responseId: string): void {
    const caller = this.requireAuth(res, auth);
    if (!caller) return;

    const record = getFeedbackResponse(this.db, caller.teamId, responseId);
    if (!record) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Response not found' }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ item: record }));
  }
}
