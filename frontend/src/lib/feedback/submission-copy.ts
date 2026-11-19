// Pure copy/rules mapping from the submission state machine to the surfaces.
// Keeping this out of the components makes the contract testable:
// - success copy exists only in the `sent` phase (a durable receipt)
// - timeout/offline/network keep the draft with Retry and Discard
// - authentication expiry preserves the draft and offers sign-in
// - the submit action reads "Sending…" while disabled

import type { SubmissionState } from './submission'

export type SurfaceMode = 'survey' | 'feedback'

export interface SubmissionView {
  status: SubmissionState['phase']
  isSending: boolean
  isSent: boolean
  isFailed: boolean
  submitLabel: string
  headline: string | null
  detail: string | null
  fieldErrors: string[]
  canSubmit: boolean
  canRetry: boolean
  canDiscard: boolean
  offerSignIn: boolean
  canonicalEvent: 'survey_completed' | 'feedback_submitted' | null
}

export function submissionView(
  state: SubmissionState,
  options: { mode: SurfaceMode; baseLabel: string },
): SubmissionView {
  const isSending = state.phase === 'sending'
  const isSent = state.phase === 'sent'
  const isFailed = state.phase === 'failed'

  let headline: string | null = null
  let detail: string | null = null
  let offerSignIn = false

  if (isSent && state.receipt) {
    headline = 'Received. Thank you.'
    detail = null
  } else if (isFailed) {
    if (state.failureKind === 'auth') {
      headline = 'Sign in to finish sending'
      // Truthful persistence claim: the draft lives in this browser session's
      // memory only - never in storage, a URL or a cookie.
      detail = 'Your answers are held in this browser session until you sign in.'
      offerSignIn = true
    } else {
      headline = state.failureKind === 'validation' ? 'Please fix and try again' : 'Not sent yet'
      detail = state.message
    }
  }

  return {
    status: state.phase,
    isSending,
    isSent,
    isFailed,
    submitLabel: isSending ? 'Sending…' : options.baseLabel,
    headline,
    detail,
    fieldErrors: state.fieldErrors,
    canSubmit: !isSending && !isSent,
    canRetry: isFailed && state.failureKind !== 'validation',
    canDiscard: isFailed || isSending,
    offerSignIn,
    canonicalEvent: state.receipt ? state.receipt.event : null,
  }
}
