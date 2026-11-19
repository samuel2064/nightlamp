// In-memory draft store. Drafts are never written to URLs or unprotected local
// storage; they survive timeout/offline/authentication expiry and are cleared
// only on confirmed success or explicit discard.

export type FeedbackDraftKind = 'feedback' | 'survey'

export type FeedbackDraftValue = string | number | boolean | string[]

export interface FeedbackDraft {
  kind: FeedbackDraftKind
  // For a survey: survey_id. For feedback: feedback_type.
  surface: string
  answers: Record<string, FeedbackDraftValue>
  dirty: boolean
}

export type DraftDiscardIntent = 'navigate' | 'close' | 'submit-success' | 'explicit-discard'

export interface FeedbackDraftStore {
  get: () => FeedbackDraft | null
  set: (draft: Omit<FeedbackDraft, 'dirty'> & { dirty?: boolean }) => void
  markDirty: () => void
  clear: (intent: DraftDiscardIntent) => boolean
  isDirty: () => boolean
}

export function createFeedbackDraftStore(): FeedbackDraftStore {
  // Intentional module-scope closure: one store instance per browser session,
  // shared by every feedback/survey surface.
  let draft: FeedbackDraft | null = null

  return {
    get: () => draft,
    set: (next) => {
      draft = { ...next, dirty: next.dirty ?? true }
    },
    markDirty: () => {
      if (draft) draft = { ...draft, dirty: true }
    },
    clear: (intent) => {
      if (intent === 'navigate' || intent === 'close') {
        // Callers must resolve a dirty draft through shouldConfirmDiscard first;
        // clearing on navigation/close is only allowed for a clean draft.
        if (draft?.dirty) return false
      }
      draft = null
      return true
    },
    isDirty: () => draft?.dirty === true,
  }
}

// One shared in-memory draft store for the browser session. It is deliberately
// a singleton: draft persistence across timeout, offline and reauthentication
// is a session-scoped behaviour, not a per-component one.
export const feedbackDraftStore = createFeedbackDraftStore()

export interface DiscardDecision {
  confirm: boolean
  offer: 'keep' | null
}

// Closing or navigating away with a dirty user-created draft offers Keep
// editing or Discard; a clean draft never blocks.
export function shouldConfirmDiscard(draft: FeedbackDraft | null): DiscardDecision {
  if (!draft || !draft.dirty) return { confirm: false, offer: null }
  return { confirm: true, offer: 'keep' }
}
