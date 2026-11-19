// Durable submission state machine for feedback and survey responses.
//
// Contract highlights (NOC-332 / NOC-161 addendum):
// - one response_id per intended submission, reused on retry
// - success only after a durable server receipt (a timeout is not success)
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
}

export type SubmitFn = (submission: FeedbackSubmission) => Promise<FeedbackReceipt>

export interface SubmissionController {
  getState: () => SubmissionState
  subscribe: (listener: (state: SubmissionState) => void) => () => void
  submit: (submission: Omit<FeedbackSubmission, 'response_id'>) => Promise<FeedbackReceipt | null>
  retry: (submission: Omit<FeedbackSubmission, 'response_id'>) => Promise<FeedbackReceipt | null>
  discard: () => void
  reset: () => void
}

export const NOT_SENT_MESSAGE = 'Not sent yet. Your feedback is still here.'

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
  options: { responseId?: string } = {},
): SubmissionController {
  let state: SubmissionState = {
    phase: 'editing',
    failureKind: null,
    message: null,
    fieldErrors: [],
    receipt: null,
    attempts: 0,
    responseId: options.responseId ?? null,
  }
  const listeners = new Set<(state: SubmissionState) => void>()

  const setState = (patch: Partial<SubmissionState>) => {
    state = { ...state, ...patch }
    for (const listener of listeners) listener(state)
  }

  const send = async (submission: Omit<FeedbackSubmission, 'response_id'>): Promise<FeedbackReceipt | null> => {
    if (state.phase === 'sending') return null
    // One response_id per intended submission; a retry reuses it.
    const responseId = state.responseId ?? generateResponseId()
    setState({ responseId, phase: 'sending', message: null, fieldErrors: [], attempts: state.attempts + 1 })
    const payload: FeedbackSubmission = { ...submission, response_id: responseId }
    try {
      const receipt = await submit(payload)
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
      setState({ phase: 'editing', failureKind: null, message: null, fieldErrors: [], responseId: null })
    },
    reset: () => {
      setState({ phase: 'editing', failureKind: null, message: null, fieldErrors: [], receipt: null, responseId: null })
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
  return receipt !== null && receipt.success === true && typeof receipt.event_id === 'string'
}
