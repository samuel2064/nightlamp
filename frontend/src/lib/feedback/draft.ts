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
  /** The response_id this draft's answers are bound to; reused on retry. */
  responseId: string | null
  /** Fingerprint of the payload the response_id is bound to. */
  payloadFingerprint: string | null
}

export type DraftDiscardIntent = 'navigate' | 'close' | 'submit-success' | 'explicit-discard'

export interface FeedbackDraftStore {
  get: () => FeedbackDraft | null
  set: (
    draft: Omit<FeedbackDraft, 'dirty' | 'responseId' | 'payloadFingerprint'> & {
      dirty?: boolean
      responseId?: string | null
      payloadFingerprint?: string | null
    }
  ) => void
  markDirty: () => void
  /** Records the response_id and payload fingerprint the answers are bound to. */
  setResponseId: (responseId: string | null, payloadFingerprint?: string | null) => void
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
      draft = {
        kind: next.kind,
        surface: next.surface,
        answers: next.answers,
        dirty: next.dirty ?? true,
        // A fresh answers object must not silently drop a bound response_id:
        // an absent value keeps whatever key the draft already holds.
        responseId: next.responseId ?? draft?.responseId ?? null,
        payloadFingerprint: next.payloadFingerprint ?? draft?.payloadFingerprint ?? null,
      }
    },
    markDirty: () => {
      if (draft) draft = { ...draft, dirty: true }
    },
    setResponseId: (responseId, payloadFingerprint) => {
      if (draft) {
        draft = {
          ...draft,
          responseId,
          payloadFingerprint: payloadFingerprint ?? (responseId === null ? null : draft.payloadFingerprint),
        }
      }
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
// is a session-scoped behaviour, not a per-component one. Module scope survives
// React remounts and client-side navigation (sign-in and back); it does not
// survive a page reload, and no surface may claim otherwise.

export const feedbackDraftStore = createFeedbackDraftStore()

/**
 * Restore path for a remounted or reauthenticated surface: only the draft for
 * exactly this surface is offered back, so a survey never inherits a feedback
 * draft (or another survey's) answers.
 */
export function restoredDraft(kind: FeedbackDraftKind, surface: string): FeedbackDraft | null {
  const draft = feedbackDraftStore.get()
  if (!draft || draft.kind !== kind || draft.surface !== surface) return null
  return draft
}

/** Answers to hydrate a surface with on mount (empty when nothing to restore). */
export function restoredAnswers(kind: FeedbackDraftKind, surface: string): Record<string, FeedbackDraftValue> {
  return restoredDraft(kind, surface)?.answers ?? {}
}

/** The response_id the restored draft is bound to, if any. */
export function restoredResponseId(kind: FeedbackDraftKind, surface: string): string | null {
  return restoredDraft(kind, surface)?.responseId ?? null
}

/** The full id+fingerprint binding of a restored draft, for a resumed
 * controller: a retry reuses the response_id only when the current payload
 * still matches the bound fingerprint. */
export function restoredBinding(
  kind: FeedbackDraftKind,
  surface: string
): { responseId: string; payloadFingerprint: string | null } | null {
  const draft = restoredDraft(kind, surface)
  if (!draft || draft.responseId === null) return null
  return { responseId: draft.responseId, payloadFingerprint: draft.payloadFingerprint }
}

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