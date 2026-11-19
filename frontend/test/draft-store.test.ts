// In-memory draft store semantics: drafts survive failure, never touch
// unprotected storage, and clear only on confirmed success or explicit discard.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createFeedbackDraftStore,
  shouldConfirmDiscard,
  type FeedbackDraft,
} from '../src/lib/feedback/draft.ts'

function draft(patch: Partial<FeedbackDraft> = {}): Omit<FeedbackDraft, 'dirty'> & { dirty?: boolean } {
  return {
    kind: 'survey',
    surface: 'nps_day14',
    answers: { score: 9 },
    ...patch,
  }
}

test('a set draft is dirty and readable', () => {
  const store = createFeedbackDraftStore()
  store.set(draft())
  assert.equal(store.isDirty(), true)
  assert.equal(store.get()?.surface, 'nps_day14')
})

test('a clean draft clears on close or navigate', () => {
  const store = createFeedbackDraftStore()
  store.set(draft({ dirty: false }))
  assert.equal(store.clear('close'), true)
  assert.equal(store.get(), null)

  store.set(draft({ dirty: false }))
  assert.equal(store.clear('navigate'), true)
  assert.equal(store.get(), null)
})

test('a dirty draft is never cleared by close or navigate', () => {
  const store = createFeedbackDraftStore()
  store.set(draft())
  assert.equal(store.clear('close'), false)
  assert.equal(store.isDirty(), true)
  assert.equal(store.clear('navigate'), false)
  assert.equal(store.get()?.answers.score, 9)
})

test('a dirty draft clears on explicit discard or confirmed success', () => {
  const store = createFeedbackDraftStore()
  store.set(draft())
  assert.equal(store.clear('explicit-discard'), true)
  assert.equal(store.get(), null)

  store.set(draft())
  assert.equal(store.clear('submit-success'), true)
  assert.equal(store.get(), null)
});

test('markDirty promotes a clean draft', () => {
  const store = createFeedbackDraftStore()
  store.set(draft({ dirty: false }))
  assert.equal(store.isDirty(), false)
  store.markDirty()
  assert.equal(store.isDirty(), true)
  assert.equal(store.clear('close'), false)
})

test('a dirty user-created draft is confirmed before it is discarded', () => {
  const dirty: FeedbackDraft = { ...draft(), dirty: true }
  assert.deepEqual(shouldConfirmDiscard(dirty), { confirm: true, offer: 'keep' })
  const clean: FeedbackDraft = { ...draft(), dirty: false }
  assert.deepEqual(shouldConfirmDiscard(clean), { confirm: false, offer: null })
  assert.deepEqual(shouldConfirmDiscard(null), { confirm: false, offer: null })
})

test('the shared store is one session-scoped instance', async () => {
  const { feedbackDraftStore } = await import('../src/lib/feedback/draft.ts')
  feedbackDraftStore.clear('explicit-discard')
  feedbackDraftStore.set(draft({ surface: 'welcome' }))
  assert.equal(feedbackDraftStore.isDirty(), true)
  assert.equal(feedbackDraftStore.clear('submit-success'), true)
  assert.equal(feedbackDraftStore.get(), null)
})
