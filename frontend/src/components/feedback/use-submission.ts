'use client'

import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import type { FeedbackReceipt, FeedbackSubmission } from '@/lib/feedback/contract'
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

// Wires the pure submission state machine to the protected tRPC mutation.
// Success is only reachable through a durable 2xx receipt from the server;
// anything else (including an uncertain timeout) lands in the failed state with
// the draft and its response_id preserved for a retry.
export function useFeedbackSubmission(): FeedbackSubmissionApi {
  const submitMutation = trpc.feedback.submit.useMutation()
  const [controller] = useState(() =>
    createSubmissionController(async (submission: FeedbackSubmission) => {
      const receipt = await submitMutation.mutateAsync(submission)
      if (!isDurableReceipt(receipt)) {
        throw new Error('The server did not record the response')
      }
      return receipt
    })
  )
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
