// Payload-bound response_id and the complete-receipt rule (NOC-340
// remediation): a retry reuses the key only for the same payload; a changed
// payload is a new intended submission with a fresh key; a receipt that does
// not agree with what was sent is a server failure, never a success.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createSubmissionController,
  isDurableReceipt,
  submissionFingerprint,
  validateFeedbackReceipt,
  type SubmissionError,
} from '../src/lib/feedback/submission.ts'
import type { FeedbackReceipt } from '../src/lib/feedback/contract.ts'

const SURVEY = {
  kind: 'survey' as const,
  survey_id: 'nps_day14' as const,
  score: 9,
  response: { reason: 'it works' },
}

const CHANGED_SURVEY = {
  kind: 'survey' as const,
  survey_id: 'nps_day14' as const,
  score: 4,
  response: { reason: 'it broke' },
}

function receipt(overrides: Partial<FeedbackReceipt> = {}): FeedbackReceipt {
  const base: FeedbackReceipt = {
    success: true,
    duplicate: false,
    response_id: 'resp-1',
    event_id: 'resp-1',
    event: 'survey_completed',
    received_at: '2026-11-19T10:00:00.000Z',
    ...overrides,
  }
  // The backend derives the canonical event_id from the response_id, so a
  // receipt always carries matching identifiers.
  return { ...base, event_id: overrides.event_id ?? base.response_id }
}

test('the fingerprint ignores answer order but not content', () => {
  assert.equal(
    submissionFingerprint({ kind: 'survey', survey_id: 'nps_day14', response: { a: '1', b: '2' } }),
    submissionFingerprint({ kind: 'survey', survey_id: 'nps_day14', response: { b: '2', a: '1' } })
  )
  assert.notEqual(
    submissionFingerprint({ kind: 'survey', survey_id: 'nps_day14', response: { a: '1' } }),
    submissionFingerprint({ kind: 'survey', survey_id: 'nps_day14', response: { a: '2' } })
  )
})

test('a retry of the same payload reuses the response_id', async () => {
  const payloads: { response_id: string }[] = []
  let attempt = 0
  const controller = createSubmissionController(async (submission) => {
    payloads.push(submission)
    attempt += 1
    if (attempt === 1) {
      const error = new Error('aborted') as SubmissionError
      error.name = 'AbortError'
      throw error
    }
    return receipt({ response_id: submission.response_id, duplicate: true })
  })

  await controller.submit(SURVEY)
  assert.equal(controller.getState().failureKind, 'timeout')

  await controller.retry(SURVEY)
  const retried = controller.getState()
  assert.equal(retried.phase, 'sent')
  assert.equal(retried.receipt?.duplicate, true)
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].response_id, payloads[1].response_id)
  assert.equal(retried.responseId, payloads[0].response_id)
})

test('a changed payload gets a fresh response_id and never reuses the old one', async () => {
  const payloads: { response_id: string; score?: number }[] = []
  const controller = createSubmissionController(async (submission) => {
    payloads.push(submission)
    return receipt({ response_id: submission.response_id, duplicate: payloads.length > 1 })
  })

  await controller.submit(SURVEY)
  assert.equal(payloads.length, 1)
  const firstId = controller.getState().responseId

  // The user edits the answer: this is a new intended submission.
  await controller.retry(CHANGED_SURVEY)
  assert.equal(payloads.length, 2)
  assert.notEqual(payloads[1].response_id, firstId)
  assert.equal(payloads[1].score, 4)
  assert.equal(controller.getState().responseId, payloads[1].response_id)
  assert.equal(controller.getState().payload?.score, 4)
})

test('a second submission with the same payload is still one intended submission', async () => {
  const payloads: { response_id: string }[] = []
  const stored = new Set<string>()
  const controller = createSubmissionController(async (submission) => {
    payloads.push(submission)
    const duplicate = stored.has(submission.response_id)
    stored.add(submission.response_id)
    return receipt({ response_id: submission.response_id, duplicate })
  })

  await controller.submit(SURVEY)
  await controller.submit(SURVEY)
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].response_id, payloads[1].response_id)
  assert.equal(stored.size, 1, 'one stored response for two attempts')
})

test('a reset starts a new intended submission with a new response_id', async () => {
  const payloads: { response_id: string }[] = []
  const controller = createSubmissionController(async (submission) => {
    payloads.push(submission)
    return receipt({ response_id: submission.response_id })
  })

  await controller.submit(SURVEY)
  const firstId = controller.getState().responseId
  controller.reset()
  await controller.submit(SURVEY)
  assert.notEqual(controller.getState().responseId, firstId)
  assert.equal(new Set(payloads.map((p) => p.response_id)).size, 2)
})

test('a receipt that does not match the submission is a server failure', async () => {
  const controller = createSubmissionController(async () => receipt({ event: 'feedback_submitted' }))
  await controller.submit(SURVEY)
  const state = controller.getState()
  assert.equal(state.phase, 'failed')
  assert.equal(state.failureKind, 'server')
  assert.equal(state.receipt, null)
})

test('an incomplete receipt is a server failure, not success', async () => {
  const cases: unknown[] = [
    { ...receipt(), event_id: '' },
    { ...receipt(), event_id: 'other-id' },
    { ...receipt(), response_id: 'other-id' },
    { ...receipt(), event: 'feedback_submitted' },
    { ...receipt(), duplicate: undefined },
    { ...receipt(), received_at: 'not-a-timestamp' },
    { ...receipt(), success: false },
    null,
  ]
  for (const value of cases) {
    assert.equal(
      validateFeedbackReceipt(value, { response_id: 'resp-1', kind: 'survey' }),
      null,
      `accepted an invalid receipt: ${JSON.stringify(value)}`
    )
  }
  assert.equal(isDurableReceipt(null), false)
  assert.equal(isDurableReceipt({ ...receipt(), event_id: '' }), false)
})

test('a timeout is reconciled through the receipt endpoint before "not sent"', async () => {
  let attempt = 0
  const controller = createSubmissionController(
    async (submission) => {
      attempt += 1
      if (attempt === 1) {
        const error = new Error('aborted') as SubmissionError
        error.name = 'AbortError'
        throw error
      }
      return receipt({ response_id: submission.response_id, duplicate: true })
    },
    {
      reconcile: async (submission) =>
        receipt({
          response_id: submission.response_id,
          event_id: submission.response_id,
          duplicate: true,
        }),
    }
  )

  await controller.submit(SURVEY)
  const state = controller.getState()
  // The server had committed the response: success is reported from the
  // reconciled receipt, not invented.
  assert.equal(state.phase, 'sent')
  assert.equal(state.receipt?.duplicate, true)
  assert.equal(state.failureKind, null)
})

test('a timeout with no server record keeps the failed draft state', async () => {
  const controller = createSubmissionController(
    async () => {
      const error = new Error('aborted') as SubmissionError
      error.name = 'AbortError'
      throw error
    },
    { reconcile: async () => null }
  )

  await controller.submit(SURVEY)
  const state = controller.getState()
  assert.equal(state.phase, 'failed')
  assert.equal(state.failureKind, 'timeout')
  assert.equal(state.message, 'Not sent yet. Your feedback is still here.')
  assert.notEqual(state.responseId, null)
})

test('a stored-but-incomplete record is reported as a server failure', async () => {
  const controller = createSubmissionController(
    async () => {
      const error = new Error('aborted') as SubmissionError
      error.name = 'AbortError'
      throw error
    },
    {
      reconcile: async () => {
        throw new Error('The server stored the response but did not confirm the recorded event.')
      },
    }
  )

  await controller.submit(SURVEY)
  const state = controller.getState()
  assert.equal(state.phase, 'failed')
  assert.equal(state.failureKind, 'server')
  assert.match(state.message ?? '', /did not confirm the recorded event/)
})