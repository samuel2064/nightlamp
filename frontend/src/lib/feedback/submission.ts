// Durable submission state machine for feedback and survey responses.
//
// Contract highlights (NOC-332 / NOC-161 addendum):
// - one response_id per intended submission, reused on retry
// - the response_id is bound to the original payload: a retry of the same
//   payload reuses the key; a changed payload is a new intended submission and
//   gets a fresh key. An old key never travels with different content.
// - success only after a complete, validated durable server receipt (a timeout
//   is not success); an ambiguous timeout is reconciled through the receipt
//   endpoint before "not sent" is claimed
// - drafts survive timeout / offline / authentication expiry (caller owns the draft)
// - a duplicate receipt is durable acceptance of the same response

import type { FeedbackReceipt, FeedbackSubmission } from './contract'
import { generateResponseId } from './response-id'

export type SubmissionPhase = 'editing' | 'sending' | 'sent' | 'failed'

export type SubmissionFailureKind = 'validation' | 'auth' | 'network' | 'timeout' | 'server'

export interface SubmissionError extends Error {
  kind: SubmissionFailureKind
  errors?: string[]
}

export function submissionError(
  kind: SubmissionFailureKind,
  message: string,
  errors?: string[],
): SubmissionError {
  const error = new Error(message) as SubmissionError
  error.kind = kind
  if (errors) error.errors = errors
  return error
}

export interface SubmissionState {
  phase: SubmissionPhase
  failureKind: SubmissionFailureKind | null
  message: string | null
  fieldErrors: string[]
  receipt: FeedbackReceipt | null
  attempts: number
  responseId: string | null
  /** The payload the current response_id is bound to (retry must not change it). */
  payload: Omit<FeedbackSubmission, 'response_id'> | null
  /** Fingerprint of that payload, restorable across a remount. */
  payloadFingerprint: string | null
}

export type SubmitFn = (submission: FeedbackSubmission) => Promise<FeedbackReceipt>

/** Resolves the durable outcome of an already-sent response_id, or null when
 * the server has no record of it. Only called for an ambiguous failure. */
export type ReconcileFn = (submission: FeedbackSubmission) => Promise<FeedbackReceipt | null>

export interface SubmissionController {
  getState: () => SubmissionState
  subscribe: (listener: (state: SubmissionState) => void) => () => void
  submit: (submission: Omit<FeedbackSubmission, 'response_id'>) => Promise<FeedbackReceipt | null>
  retry: (submission: Omit<FeedbackSubmission, 'response_id'>) => Promise<FeedbackReceipt | null>
  discard: () => void
  reset: () => void
}

export const NOT_SENT_MESSAGE = 'Not sent yet. Your feedback is still here.'

// Canonical, order-independent serialization of an intended submission. Two
// payloads with the same fingerprint are the same intended submission.
export function submissionFingerprint(submission: Omit<FeedbackSubmission, 'response_id'>): string {
  return JSON.stringify(sortValue(submission))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortValue(entry)])
    )
  }
  return value
}

const CANONICAL_EVENTS = {
  feedback: 'feedback_submitted',
  survey: 'survey_completed',
} as const

// The complete-receipt rule: a 2xx body only counts as durable acceptance when
// it agrees with what was actually sent. A mismatched, incomplete or
// unparseable receipt is a server failure, never a success.
export function validateFeedbackReceipt(
  receipt: unknown,
  expected: { response_id: string; kind: 'feedback' | 'survey' },
): FeedbackReceipt | null {
  if (!receipt || typeof receipt !== 'object') return null
  const record = receipt as Record<string, unknown>
  if (record.success !== true) return null
  if (typeof record.response_id !== 'string' || record.response_id !== expected.response_id) return null
  if (typeof record.event_id !== 'string' || record.event_id.length === 0) return null
  if (record.event_id !== expected.response_id) return null
  if (record.event !== CANONICAL_EVENTS[expected.kind]) return null
  if (typeof record.duplicate !== 'boolean') return null
  if (typeof record.received_at !== 'string' || Number.isNaN(Date.parse(record.received_at))) return null
  return record as unknown as FeedbackReceipt
}

export function classifyBackendError(error: unknown): SubmissionError {
  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind?: SubmissionFailureKind }).kind
    if (kind === 'validation' || kind === 'auth' || kind === 'network' || kind === 'timeout' || kind === 'server') {
      return error as SubmissionError
    }
  }
  if (error instanceof Error) {
    const message = error.message
    if (error.name === 'AbortError' || /timed? ?out/i.test(message)) {
      return submissionError('timeout', NOT_SENT_MESSAGE)
    }
    const httpStatus = (error as { data?: { httpStatus?: number } }).data?.httpStatus
    const trpcCode = (error as { data?: { code?: string } }).data?.code
    if (trpcCode === 'UNAUTHORIZED' || trpcCode === 'FORBIDDEN' || httpStatus === 401 || httpStatus === 403) {
      return submissionError('auth', 'Your session expired. Sign in to finish sending.')
    }
    if (httpStatus === 400 || httpStatus === 422) {
      return submissionError('validation', message, extractFieldErrors(error, message))
    }
    if (typeof httpStatus === 'number' && httpStatus >= 500) {
      return submissionError('server', message)
    }
    const statusMatch = message.match(/Backend API error (\d{3})(: ([\s\S]*))?/)
    if (statusMatch) {
      const status = Number(statusMatch[1])
      const body = statusMatch[3] ?? ''
      if (status === 400 || status === 422) {
        const errors = parseBackendErrors(body)
        return submissionError(
          'validation',
          errors[0] ?? 'Please check your answers and try again.',
          errors
        )
      }
      if (status === 401 || status === 403) {
        return submissionError('auth', 'Your session expired. Sign in to finish sending.')
      }
      if (status >= 500) return submissionError('server', message)
    }
    if (/fetch|network|ECONN|offline/i.test(message)) {
      return submissionError('network', NOT_SENT_MESSAGE)
    }
    return submissionError('server', message)
  }
  return submissionError('server', 'Something went wrong. Your feedback is still here.')
}

// The backend client throws `Backend API error 400: {"error":...,"errors":[...]}`.
// Contract validation messages are surfaced; never echo answer content.
function parseBackendErrors(body: string): string[] {
  const start = body.indexOf('{')
  if (start < 0) return []
  try {
    const parsed = JSON.parse(body.slice(start)) as { errors?: unknown }
    if (Array.isArray(parsed.errors)) {
      return parsed.errors.filter((entry): entry is string => typeof entry === 'string')
    }
  } catch {
    return []
  }
  return []
}

function extractFieldErrors(error: unknown, message?: string): string[] {
  if (error && typeof error === 'object' && Array.isArray((error as { errors?: unknown }).errors)) {
    return ((error as { errors: unknown[] }).errors).filter((e): e is string => typeof e === 'string')
  }
  return message ? parseBackendErrors(message) : []
}

export function createSubmissionController(
  submit: SubmitFn,
  options: { responseId?: string; payloadFingerprint?: string | null; reconcile?: ReconcileFn } = {},
): SubmissionController {
  let state: SubmissionState = {
    phase: 'editing',
    failureKind: null,
    message: null,
    fieldErrors: [],
    receipt: null,
    attempts: 0,
    responseId: options.responseId ?? null,
    payload: null,
    payloadFingerprint: options.payloadFingerprint ?? null,
  }
  const listeners = new Set<(state: SubmissionState) => void>()

  const setState = (patch: Partial<SubmissionState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const send = async (submission: Omit<FeedbackSubmission, 'response_id'>): Promise<FeedbackReceipt | null> => {
    if (state.phase === 'sending') return null
    // One response_id per intended submission. A retry of the same payload
    // reuses the key; a changed payload is a new intended submission with a
    // fresh key, so an old key never travels with different content. The
    // binding survives a remount through the restored fingerprint.
    const fingerprint = submissionFingerprint(submission)
    const boundFingerprint =
      state.payload !== null ? submissionFingerprint(state.payload) : state.payloadFingerprint
    const sameIntent = state.responseId !== null && boundFingerprint !== null && boundFingerprint === fingerprint
    const responseId = sameIntent ? (state.responseId as string) : generateResponseId()
    setState({
      responseId,
      payload: submission,
      payloadFingerprint: fingerprint,
      phase: 'sending',
      message: null,
      fieldErrors: [],
      attempts: state.attempts + 1,
    })
    const payload: FeedbackSubmission = { ...submission, response_id: responseId }
    try {
      const raw = await submit(payload)
      const receipt = validateFeedbackReceipt(raw, { response_id: responseId, kind: submission.kind })
      if (!receipt) {
        throw submissionError('server', 'The server did not confirm the response. Your answers are still here.')
      }
      setState({
        phase: 'sent',
        failureKind: null,
        message: null,
        fieldErrors: [],
        receipt,
        responseId,
      })
      return receipt
    } catch (error) {
      const classified = classifyBackendError(error)
      // A timeout or a lost response is ambiguous: the server may have
      // committed the response. Reconcile through the receipt endpoint before
      // claiming the draft was not sent.
      if (
        options.reconcile &&
        (classified.kind === 'timeout' || classified.kind === 'network')
      ) {
        try {
          const reconciled = await options.reconcile(payload)
          const receipt = validateFeedbackReceipt(reconciled, { response_id: responseId, kind: submission.kind })
          if (receipt) {
            setState({
              phase: 'sent',
              failureKind: null,
              message: null,
              fieldErrors: [],
              receipt,
              responseId,
            })
            return receipt
          }
        } catch (reconcileError) {
          // A stored-but-incomplete record is a server integrity failure and is
          // reported as such, never as "not sent".
          const reconciledError = classifyBackendError(reconcileError)
          if (reconciledError.kind === 'server') {
            setState({
              phase: 'failed',
              failureKind: 'server',
              message: reconciledError.message,
              fieldErrors: [],
            })
            return null
          }
          // Otherwise reconciliation itself failed: stay with the original
          // ambiguous failure below.
        }
      }
      setState({
        phase: 'failed',
        failureKind: classified.kind,
        message: classified.message,
        fieldErrors: extractFieldErrors(classified),
      })
      return null
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    submit: (submission) => send(submission),
    retry: (submission) => send(submission),
    discard: () => {
      setState({ phase: 'editing', failureKind: null, message: null, fieldErrors: [], responseId: null, payload: null, payloadFingerprint: null })
    },
    reset: () => {
      setState({ phase: 'editing', failureKind: null, message: null, fieldErrors: [], receipt: null, responseId: null, payload: null, payloadFingerprint: null })
    },
  }
}

export function nowIso(clock: () => number = () => Date.now()): string {
  return new Date(clock()).toISOString()
}

// The server emits the canonical analytics event only after durable acceptance;
// the client reports the receipt, it never emits a second event. A duplicate
// receipt (same response_id retried) is durable acceptance of the same response.
export function canonicalEventFor(receipt: FeedbackReceipt): 'survey_completed' | 'feedback_submitted' {
  return receipt.event === 'survey_completed' ? 'survey_completed' : 'feedback_submitted'
}

export function isDurableReceipt(receipt: FeedbackReceipt | null): receipt is FeedbackReceipt {
  if (receipt === null || receipt.success !== true) return false
  return typeof receipt.response_id === 'string' && receipt.response_id.length > 0 &&
    typeof receipt.event_id === 'string' && receipt.event_id.length > 0
}
