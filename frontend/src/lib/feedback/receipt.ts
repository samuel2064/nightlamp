// Receipt mapping between the protected backend response record and the safe
// metadata-only DTO the frontend publishes. The backend record itself carries
// the raw answers, team and user identifiers; this module drops all of it.

import type { FeedbackReceipt, FeedbackReceiptStatus, FeedbackSubmission } from './contract'

/** Shape of the protected backend record (a48ae78, src/analytics/store.ts). */
export interface BackendFeedbackRecord {
  response_id: unknown
  kind: unknown
  feedback_type: unknown
  survey_id: unknown
  score: unknown
  response?: unknown
  team_id?: unknown
  user_id?: unknown
  event_id: unknown
  received_at: unknown
}

const ALLOWED_RECORD_KEYS = [
  'response_id',
  'kind',
  'feedback_type',
  'survey_id',
  'score',
  'event_id',
  'received_at',
] as const

/**
 * Maps the backend record to the safe DTO, or null when the record is not a
 * recognizable stored response. Raw answers, team_id and user_id are never
 * copied into the DTO; a caller asking for them gets nothing.
 */
export function receiptStatusFromRecord(record: unknown): FeedbackReceiptStatus | null {
  if (!record || typeof record !== 'object') return null
  const raw = record as Record<string, unknown>
  const responseId = raw.response_id
  const kind = raw.kind
  if (typeof responseId !== 'string' || responseId.length === 0) return null
  if (kind !== 'feedback' && kind !== 'survey') return null
  const receivedAt = raw.received_at
  if (typeof receivedAt !== 'string' || Number.isNaN(Date.parse(receivedAt))) return null
  const eventId = typeof raw.event_id === 'string' && raw.event_id.length > 0 ? raw.event_id : null
  const score = typeof raw.score === 'number' && Number.isFinite(raw.score) ? raw.score : null
  return {
    response_id: responseId,
    kind,
    event: kind === 'survey' ? 'survey_completed' : 'feedback_submitted',
    event_id: eventId,
    received_at: receivedAt,
    score,
  }
}

export { ALLOWED_RECORD_KEYS }

/**
 * Rebuilds a validatable receipt from the safe DTO for an ambiguous timeout.
 * Returns null when the server has no record of this response_id (the claim
 * "not sent" is then truthful); throws a server-kind error when a record
 * exists but cannot prove durable acceptance (stored without its canonical
 * event) so the surface never reports a false success.
 */
export function receiptFromStatus(
  status: FeedbackReceiptStatus | null,
  expected: Pick<FeedbackSubmission, 'response_id' | 'kind'>,
): FeedbackReceipt | null {
  if (!status) return null
  if (status.response_id !== expected.response_id) return null
  if (status.event_id === null) {
    throw new Error(
      'The server stored the response but did not confirm the recorded event. Retry is safe: it reuses the same response id.'
    )
  }
  return {
    success: true,
    // A reconciled response was accepted earlier, so this attempt is a duplicate.
    duplicate: true,
    response_id: status.response_id,
    event_id: status.event_id,
    event: status.event,
    received_at: status.received_at,
  }
}