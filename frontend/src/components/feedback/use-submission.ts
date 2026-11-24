'use client'

import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import type { FeedbackReceipt, FeedbackSubmission } from '@/lib/feedback/contract'
import { restoredBinding } from '@/lib/feedback/draft'
import { receiptFromStatus } from '@/lib/feedback/receipt'
import {
  createSubmissionController,
  type SubmissionController,
  type SubmissionState,
} from '@/lib/feedback/submission'

export interface FeedbackSubmissionApi {
  state: SubmissionState
  submit: SubmissionController['submit']
  retry: SubmissionController['retry']
  discard: SubmissionController['discard']
  reset: SubmissionController['reset']
  isSending: boolean
}

function isDurableReceipt(value: unknown): value is FeedbackReceipt {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.success === true &&
    typeof record.response_id === 'string' &&
    typeof record.event_id === 'string'
  )
}

/** Surface identity used to restore a session draft after a remount or a
 * reauthentication: only the same kind+surface draft is offered back. */
export interface RestoreKey {
  kind: 'feedback' | 'survey'
  surface: string
}

// Wires the pure submission state machine to the protected tRPC mutation.
// Success is only reachable through a complete, validated durable receipt from
// the server; anything else (including an uncertain timeout) lands in the
// failed state with the draft and its response_id preserved for a retry. An
// ambiguous failure is reconciled through the receipt route before the
// "not sent yet" copy is shown.
export function useFeedbackSubmission(restore: RestoreKey | null = null): FeedbackSubmissionApi {
  const submitMutation = trpc.feedback.submit.useMutation()
  const utils = trpc.useUtils()
  const [controller] = useState(() => {
    const binding = restore ? restoredBinding(restore.kind, restore.surface) : null
    return createSubmissionController(
      async (submission: FeedbackSubmission) => {
        const receipt = await submitMutation.mutateAsync(submission)
        if (!isDurableReceipt(receipt)) {
          throw new Error('The server did not record the response')
        }
        return receipt
      },
      {
        responseId: binding?.responseId,
        payloadFingerprint: binding?.payloadFingerprint ?? null,
        reconcile: async (submission: FeedbackSubmission) => {
          // The receipt route answers NOT_FOUND for an unknown response, which
          // reconciles as "no record" (the draft was not sent).
          const status = await utils.feedback.receipt.fetch({ responseId: submission.response_id })
          return receiptFromStatus(status, submission)
        },
      }
    )
  })
  const [state, setState] = useState<SubmissionState>(controller.getState())

  useEffect(() => controller.subscribe(setState), [controller])

  return {
    state,
    submit: controller.submit,
    retry: controller.retry,
    discard: controller.discard,
    reset: controller.reset,
    isSending: state.phase === 'sending',
  }
}