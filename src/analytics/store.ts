import type { Database } from 'sql.js';
import { tenantFilter } from '../api/tenant';
import type { TenantFilter } from '../api/tenant';
import type { ValidatedAnalyticsEvent } from './event-contract';

export interface AnalyticsEventRecord {
  event_id: string;
  event: string;
  schema_version: string;
  occurred_at: string;
  team_id: string | null;
  user_id: string;
  properties: Record<string, unknown>;
  received_at: string;
  forwarded: boolean;
  forward_status: string | null;
  forward_error: string | null;
}

export interface FeedbackResponseRecord {
  response_id: string;
  kind: 'feedback' | 'survey';
  feedback_type: string | null;
  survey_id: string | null;
  score: number | null;
  team_id: string | null;
  user_id: string;
  response: Record<string, unknown>;
  event_id: string | null;
  received_at: string;
}

export function tenantScopeKey(teamId: string | null, userId?: string | null): string {
  if (teamId !== null) return `team:${teamId}`;
  return userId ? `personal:${userId}` : 'personal';
}

export function analyticsDedupKey(teamId: string | null, eventId: string, userId?: string | null): string {
  return `${tenantScopeKey(teamId, userId)}:event:${eventId}`;
}

export function feedbackDedupKey(teamId: string | null, responseId: string, userId?: string | null): string {
  return `${tenantScopeKey(teamId, userId)}:response:${responseId}`;
}

function parseProperties(raw: any): Record<string, unknown> {
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function recordAnalyticsEvent(
  db: Database,
  input: {
    teamId: string | null;
    userId: string;
    event: ValidatedAnalyticsEvent;
    properties?: Record<string, unknown>;
  },
): { inserted: boolean; record: AnalyticsEventRecord } {
  const properties = input.properties ?? input.event.properties;
  const dedupKey = analyticsDedupKey(input.teamId, input.event.event_id, input.userId);

  const existing = db.exec(
    'SELECT id, event, schema_version, occurred_at, team_id, user_id, properties, received_at, forwarded, forward_error FROM analytics_events WHERE dedup_key = ?',
    [dedupKey],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { inserted: false, record: mapAnalyticsRow(existing[0].values[0]) };
  }

  try {
    db.run(
      `INSERT INTO analytics_events (id, dedup_key, team_id, user_id, event, schema_version, occurred_at, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.event.event_id,
        dedupKey,
        input.teamId,
        input.userId,
        input.event.event,
        input.event.schema_version,
        input.event.timestamp,
        JSON.stringify(properties),
      ],
    );
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      const duplicate = db.exec(
        'SELECT id, event, schema_version, occurred_at, team_id, user_id, properties, received_at, forwarded, forward_error FROM analytics_events WHERE dedup_key = ?',
        [dedupKey],
      );
      if (duplicate.length > 0 && duplicate[0].values.length > 0) {
        return { inserted: false, record: mapAnalyticsRow(duplicate[0].values[0]) };
      }
    }
    throw err;
  }

  const inserted = db.exec(
    'SELECT id, event, schema_version, occurred_at, team_id, user_id, properties, received_at, forwarded, forward_error FROM analytics_events WHERE dedup_key = ?',
    [dedupKey],
  );
  return {
    inserted: true,
    record: mapAnalyticsRow(inserted[0].values[0]),
  };
}

function mapAnalyticsRow(row: any[]): AnalyticsEventRecord {
  return {
    event_id: row[0],
    event: row[1],
    schema_version: row[2],
    occurred_at: row[3],
    team_id: row[4] === null ? null : String(row[4]),
    user_id: row[5],
    properties: parseProperties(row[6]),
    received_at: row[7],
    forwarded: row[8] === 1,
    forward_status: row[8] === 1 ? 'sent' : null,
    forward_error: row[9] === null ? null : String(row[9]),
  };
}

export function markAnalyticsForward(
  db: Database,
  teamId: string | null,
  eventId: string,
  userId: string | null,
  outcome: { forwarded: boolean; error?: string },
): void {
  const dedupKey = analyticsDedupKey(teamId, eventId, userId);
  if (outcome.forwarded) {
    db.run(
      'UPDATE analytics_events SET forwarded = 1, forward_attempts = forward_attempts + 1, forward_error = NULL WHERE dedup_key = ?',
      [dedupKey],
    );
    return;
  }
  db.run(
    'UPDATE analytics_events SET forwarded = 0, forward_attempts = forward_attempts + 1, forward_error = ? WHERE dedup_key = ?',
    [outcome.error ? String(outcome.error).slice(0, 500) : 'forward failed', dedupKey],
  );
}

/**
 * Scope for the analytics collections.
 *
 * A caller with a team sees that team's rows. A caller without one sees only
 * the rows it recorded itself, so one signed-in user can never read another
 * user's personal analytics events (NOC-303 finding 3). An empty caller
 * identity matches nothing.
 */
export function analyticsScope(teamId: string | null, userId: string): TenantFilter {
  if (teamId !== null) {
    return { clause: 'team_id = ?', params: [teamId] };
  }
  if (!userId) {
    return { clause: '1 = 0', params: [] };
  }
  return { clause: 'team_id IS NULL AND user_id = ?', params: [userId] };
}

export function listAnalyticsEvents(
  db: Database,
  teamId: string | null,
  limit = 50,
  userId = '',
): AnalyticsEventRecord[] {
  const scope = analyticsScope(teamId, userId);
  const result = db.exec(
    `SELECT id, event, schema_version, occurred_at, team_id, user_id, properties, received_at, forwarded, forward_error
     FROM analytics_events WHERE ${scope.clause} ORDER BY received_at DESC LIMIT ?`,
    [...scope.params, limit],
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => mapAnalyticsRow(row));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function normalizeSubmittedPayload(submitted: {
  kind: string;
  feedback_type?: string;
  survey_id?: string;
  score?: number;
  response: Record<string, unknown>;
}): string {
  return stableStringify({
    kind: submitted.kind,
    feedback_type: submitted.feedback_type ?? null,
    survey_id: submitted.survey_id ?? null,
    score: submitted.score ?? null,
    response: submitted.response,
  });
}

function normalizeStoredPayload(record: FeedbackResponseRecord): string {
  return stableStringify({
    kind: record.kind,
    feedback_type: record.feedback_type ?? null,
    survey_id: record.survey_id ?? null,
    score: record.score === null ? null : Number(record.score),
    response: record.response,
  });
}

export function feedbackPayloadMatches(
  record: FeedbackResponseRecord,
  submitted: {
    kind: string;
    feedback_type?: string;
    survey_id?: string;
    score?: number;
    response: Record<string, unknown>;
  },
): boolean {
  return normalizeStoredPayload(record) === normalizeSubmittedPayload(submitted);
}

export function recordFeedbackSubmission(
  db: Database,
  input: {
    teamId: string | null;
    userId: string;
    response: {
      response_id: string;
      kind: 'feedback' | 'survey';
      feedback_type?: string;
      survey_id?: string;
      score?: number;
      response: Record<string, unknown>;
    };
    event: ValidatedAnalyticsEvent;
    properties: Record<string, unknown>;
    receivedAt?: string;
  },
): { inserted: boolean; record: FeedbackResponseRecord } {
  const dedupKey = feedbackDedupKey(input.teamId, input.response.response_id, input.userId);
  const receivedAt = input.receivedAt ?? new Date().toISOString();

  const existing = db.exec(
    'SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at FROM feedback_responses WHERE dedup_key = ?',
    [dedupKey],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { inserted: false, record: mapFeedbackRow(existing[0].values[0]) };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.run(
      `INSERT INTO feedback_responses (id, dedup_key, team_id, user_id, kind, feedback_type, survey_id, score, response, event_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.response.response_id,
        dedupKey,
        input.teamId,
        input.userId,
        input.response.kind,
        input.response.feedback_type ?? null,
        input.response.survey_id ?? null,
        input.response.score ?? null,
        JSON.stringify(input.response.response),
        input.event.event_id,
        receivedAt,
      ],
    );

    db.run(
      `INSERT INTO analytics_events (id, dedup_key, team_id, user_id, event, schema_version, occurred_at, properties)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.event.event_id,
        analyticsDedupKey(input.teamId, input.event.event_id),
        input.teamId,
        input.userId,
        input.event.event,
        input.event.schema_version,
        input.event.timestamp,
        JSON.stringify(input.properties),
      ],
    );

    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction is already closed by SQLite.
    }
    throw error;
  }

  const stored = db.exec(
    'SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at FROM feedback_responses WHERE dedup_key = ?',
    [dedupKey],
  );
  return { inserted: true, record: mapFeedbackRow(stored[0].values[0]) };
}

export function recordFeedbackResponse(
  db: Database,
  input: {
    teamId: string | null;
    userId: string;
    response: {
      response_id: string;
      kind: 'feedback' | 'survey';
      feedback_type?: string;
      survey_id?: string;
      score?: number;
      response: Record<string, unknown>;
    };
    eventId: string;
  },
): { inserted: boolean; record: FeedbackResponseRecord } {
  const dedupKey = feedbackDedupKey(input.teamId, input.response.response_id, input.userId);

  const existing = db.exec(
    'SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at FROM feedback_responses WHERE dedup_key = ?',
    [dedupKey],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    return { inserted: false, record: mapFeedbackRow(existing[0].values[0]) };
  }

  try {
    db.run(
      `INSERT INTO feedback_responses (id, dedup_key, team_id, user_id, kind, feedback_type, survey_id, score, response, event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.response.response_id,
        dedupKey,
        input.teamId,
        input.userId,
        input.response.kind,
        input.response.feedback_type ?? null,
        input.response.survey_id ?? null,
        input.response.score ?? null,
        JSON.stringify(input.response.response),
        input.eventId,
      ],
    );
  } catch (err: any) {
    if (String(err?.message || '').includes('UNIQUE constraint failed')) {
      const duplicate = db.exec(
        'SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at FROM feedback_responses WHERE dedup_key = ?',
        [dedupKey],
      );
      if (duplicate.length > 0 && duplicate[0].values.length > 0) {
        return { inserted: false, record: mapFeedbackRow(duplicate[0].values[0]) };
      }
    }
    throw err;
  }

  const inserted = db.exec(
    'SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at FROM feedback_responses WHERE dedup_key = ?',
    [dedupKey],
  );
  return { inserted: true, record: mapFeedbackRow(inserted[0].values[0]) };
}

function mapFeedbackRow(row: any[]): FeedbackResponseRecord {
  return {
    response_id: row[0],
    kind: row[1],
    feedback_type: row[2] === null ? null : String(row[2]),
    survey_id: row[3] === null ? null : String(row[3]),
    score: row[4] === null ? null : Number(row[4]),
    team_id: row[5] === null ? null : String(row[5]),
    user_id: row[6],
    response: parseProperties(row[7]),
    event_id: row[8] === null ? null : String(row[8]),
    received_at: row[9],
  };
}

export function listFeedbackResponses(
  db: Database,
  teamId: string | null,
  limit = 50,
  userId = '',
): FeedbackResponseRecord[] {
  const scope = analyticsScope(teamId, userId);
  const result = db.exec(
    `SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at
     FROM feedback_responses WHERE ${scope.clause} ORDER BY received_at DESC LIMIT ?`,
    [...scope.params, limit],
  );
  if (result.length === 0) return [];
  return result[0].values.map((row: any[]) => mapFeedbackRow(row));
}

export function getFeedbackResponse(
  db: Database,
  teamId: string | null,
  responseId: string,
  userId = '',
): FeedbackResponseRecord | null {
  const scope = analyticsScope(teamId, userId);
  const result = db.exec(
    `SELECT id, kind, feedback_type, survey_id, score, team_id, user_id, response, event_id, received_at
     FROM feedback_responses WHERE id = ? AND ${scope.clause}`,
    [responseId, ...scope.params],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return mapFeedbackRow(result[0].values[0]);
}
