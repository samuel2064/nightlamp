// Session-scoped draft restore (NOC-340 remediation): the in-memory draft and
// the response_id bound to it survive a remount and a reauthentication. The
// draft is never written to a URL, storage, a cookie or a log, and it is
// cleared only on confirmed success or an explicit discard.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFeedbackDraftStore,
  feedbackDraftStore,
  restoredAnswers,
  restoredBinding,
  restoredDraft,
  restoredResponseId,
  shouldConfirmDiscard,
} from '../src/lib/feedback/draft.ts'
import {
  createSubmissionController,
  submissionFingerprint,
  type SubmissionError,
} from '../src/lib/feedback/submission.ts'
import type { FeedbackReceipt } from '../src/lib/feedback/contract.ts'

const SURVEY_ANSWERS = { score: 8, reason: 'it works' }
const SURVEY_PAYLOAD = { kind: 'survey' as const, survey_id: 'nps_day14' as const, response: { score: 8 } }

test('a remounted survey resumes its draft answers and response_id', async () => {
  // First mount: the user types and the submission fails (session expired).
  // The store is the shared module-scope singleton, exactly what a React
  // remount or a client-side navigation to /sign-in keeps alive. The durable
  // hook binds the response_id to the payload fingerprint at send time.
  feedbackDraftStore.set({ kind: 'survey', surface: 'nps_day14', answers: SURVEY_ANSWERS })
  feedbackDraftStore.setResponseId('resp-abc', submissionFingerprint(SURVEY_PAYLOAD))
  const controller = createSubmissionController(
    async () => {
      const error = new Error('expired') as SubmissionError
      throw Object.assign(error, { data: { code: 'UNAUTHORIZED' } })
    },
    { responseId: 'resp-abc', payloadFingerprint: submissionFingerprint(SURVEY_PAYLOAD) }
  )
  await controller.submit(SURVEY_PAYLOAD)
  assert.equal(controller.getState().failureKind, 'auth')
  assert.equal(controller.getState().responseId, 'resp-abc')

  // Remount after reauthentication: the draft resumes with its answers and
  // the response_id they were bound to.
  const restored = restoredDraft('survey', 'nps_day14')
  assert.deepEqual(restored?.answers, SURVEY_ANSWERS)
  assert.equal(restoredResponseId('survey', 'nps_day14'), 'resp-abc')
  assert.deepEqual(restoredAnswers('survey', 'nps_day14'), SURVEY_ANSWERS)

  // The resumed controller reuses the bound response_id on retry.
  const payloads: { response_id: string }[] = []
  const binding = restoredBinding('survey', 'nps_day14')
  assert.equal(binding?.responseId, 'resp-abc')
  const resumed = createSubmissionController(
    async (submission) => {
      payloads.push(submission)
      return {
        success: true,
        duplicate: true,
        response_id: submission.response_id,
        event_id: submission.response_id,
        event: 'survey_completed',
        received_at: '2026-11-19T11:00:00.000Z',
      } satisfies FeedbackReceipt
    },
    { responseId: binding?.responseId, payloadFingerprint: binding?.payloadFingerprint ?? null }
  )
  await resumed.retry(SURVEY_PAYLOAD)
  assert.equal(payloads[0].response_id, 'resp-abc')
  assert.equal(resumed.getState().phase, 'sent')
  feedbackDraftStore.clear('explicit-discard')
})

test('a restored draft never comes from another surface', () => {
  feedbackDraftStore.set({ kind: 'survey', surface: 'nps_day14', answers: SURVEY_ANSWERS })
  assert.equal(restoredDraft('feedback', 'bug_report'), null)
  assert.equal(restoredDraft('survey', 'nps_day30'), null)
  assert.deepEqual(restoredAnswers('survey', 'nps_day30'), {})
  assert.equal(restoredResponseId('survey', 'nps_day30'), null)
  feedbackDraftStore.clear('explicit-discard')
})

test('a restored draft keeps its response_id when answers are overwritten', () => {
  const store = createFeedbackDraftStore()
  store.set({ kind: 'feedback', surface: 'bug_report', answers: { description: 'x' } })
  store.setResponseId('resp-1')
  // A surface writing fresh answers must not drop the bound key.
  store.set({ kind: 'feedback', surface: 'bug_report', answers: { description: 'xy' } })
  assert.equal(store.get()?.responseId, 'resp-1')
  store.setResponseId(null)
  assert.equal(store.get()?.responseId, null)
})

test('the draft survives a declined navigation attempt', () => {
  const store = createFeedbackDraftStore()
  store.set({ kind: 'feedback', surface: 'general', answers: { message: 'hi' } })
  assert.equal(store.isDirty(), true)
  assert.deepEqual(shouldConfirmDiscard(store.get()), { confirm: true, offer: 'keep' })
  // Declining the discard offer keeps the draft: close/navigate never clears.
  assert.equal(store.clear('close'), false)
  assert.notEqual(store.get(), null)
  // An explicit discard clears it.
  assert.equal(store.clear('explicit-discard'), true)
  assert.equal(store.get(), null)
})

test('success and explicit discard are the only clears', () => {
  const store = createFeedbackDraftStore()
  store.set({ kind: 'feedback', surface: 'general', answers: { message: 'hi' } })
  assert.equal(store.clear('submit-success'), true)
  assert.equal(store.get(), null)

  store.set({ kind: 'feedback', surface: 'general', answers: { message: 'hi' } })
  assert.equal(store.clear('navigate'), false)
  assert.notEqual(store.get(), null)
})