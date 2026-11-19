'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SubmissionController } from '@/lib/feedback/submission'
import { feedbackDraftStore, shouldConfirmDiscard } from '@/lib/feedback/draft'
import type { FeedbackSubmission } from '@/lib/feedback/contract'
import type { SubmissionView } from '@/lib/feedback/submission-copy'
import { submissionView } from '@/lib/feedback/submission-copy'
import { useFeedbackSubmission } from './use-submission'

export type SurfaceKind = 'feedback' | 'survey'

export interface DurableSubmissionConfig<TValues> {
  kind: SurfaceKind
  // For a survey: survey_id. For feedback: feedback_type.
  surface: string
  values: TValues
  // Client-side validation; empty means the payload can be built.
  validate: (values: TValues) => { fieldId: string; message: string }[]
  // Builds the backend payload from the current values. Returns null when the
  // values cannot be mapped to the scalar contract.
  toSubmission: (
    values: TValues,
    response: Record<string, string | number | boolean>,
  ) => Omit<FeedbackSubmission, 'response_id'> | null
}

export interface DurableSubmissionApi {
  state: ReturnType<SubmissionController['getState']>
  view: SubmissionView
  issues: { fieldId: string; message: string }[]
  submit: () => void
  retry: () => void
  discard: () => void
  reset: () => void
}

// Wires a surface's values to the durable submission machine while preserving
// the in-memory draft. The draft is cleared only after a confirmed success or
// an explicit discard - never on navigation attempts that the user declined.
// A remounted surface (authentication expiry, navigation back) resumes the
// session draft, including the original response_id bound to it.
export function useDurableSubmission<TValues extends Record<string, string | number | boolean | string[]>>(
  config: DurableSubmissionConfig<TValues>,
): DurableSubmissionApi {
  const submission = useFeedbackSubmission({ kind: config.kind, surface: config.surface })
  const [issues, setIssues] = useState<{ fieldId: string; message: string }[]>([])
  const { kind, surface, values, validate, toSubmission } = config

  const draft = useMemo(() => ({ kind, surface, answers: values }), [kind, surface, values])

  // Keep the shared in-memory draft current as the user edits.
  useEffect(() => {
    if (Object.keys(values).length > 0) {
      feedbackDraftStore.set(draft)
    }
  }, [draft, values])

  // Keep the draft's response_id and payload binding in step with the
  // controller: the id the answers are bound to must survive a remount and a
  // reauthentication.
  useEffect(() => {
    if (submission.state.responseId !== null) {
      feedbackDraftStore.setResponseId(
        submission.state.responseId,
        submission.state.payloadFingerprint
      )
    }
  }, [submission.state.responseId, submission.state.payloadFingerprint])

  const buildSubmission = useCallback((): Omit<FeedbackSubmission, 'response_id'> | null => {
    const mapped = mapValuesToResponse(values)
    if (!mapped.ok) return null
    return toSubmission(values, mapped.response)
  }, [values, toSubmission])

  const view = useMemo(
    () =>
      submissionView(submission.state, {
        mode: kind,
        baseLabel: kind === 'survey' ? 'Submit' : 'Send',
      }),
    [submission.state, kind],
  )

  const send = useCallback(
    (mode: 'submit' | 'retry') => {
      const found = validate(values)
      setIssues(found)
      if (found.length > 0) return
      const payload = buildSubmission()
      if (!payload) {
        setIssues([{ fieldId: '', message: 'One of your answers has an unsupported format.' }])
        return
      }
      feedbackDraftStore.set(draft)
      void (mode === 'retry' ? submission.retry(payload) : submission.submit(payload))
    },
    [validate, values, buildSubmission, submission, draft],
  )

  // A durable receipt clears the draft; failures and cancellations keep it.
  useEffect(() => {
    if (submission.state.phase === 'sent') {
      feedbackDraftStore.clear('submit-success')
    }
  }, [submission.state.phase])

  const discard = useCallback(() => {
    feedbackDraftStore.clear('explicit-discard')
    submission.discard()
    setIssues([])
  }, [submission])

  return {
    state: submission.state,
    view,
    issues,
    submit: () => send('submit'),
    retry: () => send('retry'),
    discard,
    reset: submission.reset,
  }
}

// Closing, Escape and navigation go through this guard: a dirty user-created
// draft is never silently thrown away (NOC-161 addendum, form state and copy).
export function useDraftGuard(onDismiss: () => void) {
  const [confirming, setConfirming] = useState(false)

  const requestClose = useCallback(() => {
    if (shouldConfirmDiscard(feedbackDraftStore.get())) {
      setConfirming(true)
      return
    }
    onDismiss()
  }, [onDismiss])

  const keepEditing = useCallback(() => setConfirming(false), [])

  // Confirming Discard here is the explicit discard: the shared in-memory
  // draft is cleared at the same time, so the next surface does not ask again
  // about answers the user already threw away.
  const discardNow = useCallback(() => {
    feedbackDraftStore.clear('explicit-discard')
    onDismiss()
  }, [onDismiss])

  return { requestClose, confirming, keepEditing, discardNow }
}

// Shared scalar mapping: arrays are joined, oversized or non-scalar values are
// rejected by the caller before anything leaves the browser.
export function mapValuesToResponse(values: Record<string, string | number | boolean | string[]>): {
  ok: boolean
  response: Record<string, string | number | boolean>
} {
  const response: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed.length === 0) continue
      response[key] = trimmed
      continue
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      response[key] = value
      continue
    }
    if (Array.isArray(value)) {
      const joined = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0).join(', ')
      if (joined.length > 0) response[key] = joined
      continue
    }
    return { ok: false, response: {} }
  }
  return { ok: true, response }
}
