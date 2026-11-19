// Durable submission behaviour (NOC-332 acceptance evidence):
// successful acceptance, server validation error, timeout retry, offline retry,
// reauthentication with draft preservation, and one response per response_id.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalEventFor,
  classifyBackendError,
  createSubmissionController,
  isDurableReceipt,
  type SubmissionError,
} from '../src/lib/feedback/submission.ts'
import type { FeedbackReceipt } from '../src/lib/feedback/contract.ts'
import { submissionView } from '../src/lib/feedback/submission-copy.ts'

const SURVEY = {
  kind: 'survey' as const,
  survey_id: 'nps_day14' as const,
  score: 9,
  response: { reason: 'it works' },
}

function receipt(overrides: Partial<FeedbackReceipt> = {}): FeedbackReceipt {
  const base = {
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
  return { ...base, event_id: overrides.event_id ?? base.response_id } as FeedbackReceipt
}

test('success is only reachable through a durable receipt', async () => {
  const payloads: { response_id: string }[] = []
  const controller = createSubmissionController(async (submission) => {
    payloads.push(submission)
    return receipt({ response_id: submission.response_id })
  })

  assert.equal(controller.getState().phase, 'editing')
  const sent = await controller.submit(SURVEY)
  assert.equal(sent?.event, 'survey_completed')
  assert.equal(controller.getState().phase, 'sent')
  assert.equal(isDurableReceipt(controller.getState().receipt), true)
  assert.equal(canonicalEventFor(controller.getState().receipt!), 'survey_completed')
  assert.equal(payloads.length, 1)
})

test('a timeout is not success: the draft stays and Retry reuses the response_id', async () => {
  const payloads: { response_id: string }[] = []
  let attempt = 0
  const controller = createSubmissionController(async (submission) => {
    payloads.push(submission)
    attempt += 1
    if (attempt === 1) {
      const error = new Error('The operation was aborted') as SubmissionError
      error.name = 'AbortError'
      throw error
    }
    return receipt({ response_id: submission.response_id, duplicate: true })
  })

  await controller.submit(SURVEY)
  const failed = controller.getState()
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.failureKind, 'timeout')
  assert.equal(failed.message, 'Not sent yet. Your feedback is still here.')
  assert.equal(failed.receipt, null)

  await controller.retry(SURVEY)
  const retried = controller.getState()
  assert.equal(retried.phase, 'sent')
  assert.equal(retried.receipt?.duplicate, true)

  // One intended submission, one response_id, one stored response.
  assert.equal(payloads.length, 2)
  assert.equal(payloads[0].response_id, payloads[1].response_id)
  assert.equal(retried.responseId, payloads[0].response_id)
})

test('a retry of one intended submission is one response: same response_id, duplicate receipt', async () => {
  const stored = new Set<string>()
  const controller = createSubmissionController(async (submission) => {
    const duplicate = stored.has(submission.response_id)
    stored.add(submission.response_id)
    return receipt({ response_id: submission.response_id, duplicate })
  })

  const first = await controller.submit(SURVEY)
  assert.equal(first?.duplicate, false)

  // Submitting again without a reset is a retry of the same intended
  // submission: the same response_id travels and the server answers duplicate.
  const second = await controller.submit(SURVEY)
  assert.equal(second?.duplicate, true)
  assert.equal(first?.response_id, second?.response_id)
  assert.equal(stored.size, 1, 'one stored response for two attempts')

  // A reset means a new intended submission and therefore a new response_id.
  controller.reset()
  const third = await controller.submit(SURVEY)
  assert.equal(third?.duplicate, false)
  assert.notEqual(third?.response_id, first?.response_id)
  assert.equal(stored.size, 2)
})

test('a server validation error surfaces the backend messages and keeps the draft', async () => {
  const controller = createSubmissionController(async () => {
    throw new Error(
      'Backend API error 400: {"error":"Invalid feedback response","errors":["response \\"score\\" must be between 0 and 10"]}'
    )
  })

  await controller.submit(SURVEY)
  const state = controller.getState()
  assert.equal(state.phase, 'failed')
  assert.equal(state.failureKind, 'validation')
  assert.equal(state.fieldErrors.length, 1)
  assert.match(state.fieldErrors[0], /must be between 0 and 10/)
  assert.equal(state.responseId !== null, true, 'response_id survives for the retry')
})

test('offline keeps the draft with the not-sent-yet copy', async () => {
  const controller = createSubmissionController(async () => {
    throw new Error('Failed to fetch')
  })

  await controller.submit(SURVEY)
  assert.equal(controller.getState().failureKind, 'network')
  assert.equal(controller.getState().message, 'Not sent yet. Your feedback is still here.')
  assert.equal(controller.discard !== undefined, true)
})

test('authentication expiry preserves the draft and offers sign-in', async () => {
  const controller = createSubmissionController(async () => {
    throw Object.assign(new Error('UNAUTHORIZED'), { data: { code: 'UNAUTHORIZED' } })
  })

  await controller.submit(SURVEY)
  const state = controller.getState()
  assert.equal(state.failureKind, 'auth')
  assert.equal(state.message, 'Your session expired. Sign in to finish sending.')
  assert.equal(state.responseId !== null, true, 'the draft keeps its response_id')

  const view = submissionView(state, { mode: 'survey', baseLabel: 'Submit' })
  assert.equal(view.offerSignIn, true)
})

test('error classification keeps the failure kinds apart', () => {
  assert.equal(classifyBackendError(new Error('network error')).kind, 'network')
  assert.equal(
    classifyBackendError(Object.assign(new Error('nope'), { data: { httpStatus: 500 } })).kind,
    'server'
  )
  assert.equal(
    classifyBackendError(Object.assign(new Error('nope'), { data: { httpStatus: 400 } })).kind,
    'validation'
  )
  assert.equal(classifyBackendError({ kind: 'timeout' }).kind, 'timeout')
  assert.equal(classifyBackendError('boom').kind, 'server')
})

test('discard resets to editing and releases the response_id', async () => {
  const controller = createSubmissionController(async () => {
    throw new Error('Failed to fetch')
  })
  await controller.submit(SURVEY)
  controller.discard()
  const state = controller.getState()
  assert.equal(state.phase, 'editing')
  assert.equal(state.failureKind, null)
  assert.equal(state.responseId, null)
})

test('only one in-flight submission at a time', async () => {
  let active = 0
  let maxActive = 0
  const controller = createSubmissionController(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return receipt()
  })
  const [a, b] = await Promise.all([controller.submit(SURVEY), controller.retry(SURVEY)])
  assert.equal(a === null || b === null, true)
  assert.equal(maxActive, 1)
})
