// Automatic-survey eligibility engine (NOC-161 2026-11-16 addendum):
// - automatic surveys appear only after a successful action plus an idle check
// - at most one automatic survey per session
// - eligibility is rechecked after the idle delay; suppressed prompts are
//   discarded, never queued
// - user-initiated surfaces bypass this engine entirely
// - a completion is never counted as a dismissal, and a suppression discards a
//   prompt that is already visible, not only one still waiting
//
// Purity note: the scheduler is framework-free so the trigger, cap,
// suppression, completion-vs-dismissal and discard rules can be exercised
// directly in tests. SurveyProvider is a thin wiring layer over this engine.

import type { SurveyId } from './contract'

export type SuppressionReason = 'incident_response' | 'critical_alert' | 'unsaved_work' | 'route_change'

export const SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'incident_response',
  'critical_alert',
  'unsaved_work',
  'route_change',
]

// The automatic surface, kept framework-free so "which flows are actually
// claimed" is testable. A trigger exists only when a durable server acceptance
// backs it in this release: monitor creation, team invitation and the
// day-14/day-30 and exit surveys have no such action, so nothing schedules
// them automatically.
export type SurveyTriggerAction = 'alert_received' | 'playbook_completed'

export const MICROSURVEY_FOR_ACTION: Record<SurveyTriggerAction, SurveyId> = {
  alert_received: 'microsurvey_alert_received',
  playbook_completed: 'microsurvey_playbook_completed',
}

/** Surveys the user opens themselves: modal, focus-contained surfaces. */
export const USER_INITIATED_SURVEYS: readonly SurveyId[] = [
  'welcome',
  'nps_day14',
  'nps_day30',
  'exit_account_delete',
  'exit_inactivity',
]

/** Surveys the scheduler may open after a successful action: inline prompts. */
export const AUTOMATIC_SURVEYS: readonly SurveyId[] = [
  'microsurvey_monitor_created',
  'microsurvey_alert_received',
  'microsurvey_playbook_completed',
]

export type ScheduleOutcome =
  | 'shown'
  | 'delayed'
  | 'suppressed'
  | 'declined'
  | 'already-shown'

export interface SurveySchedulerOptions {
  idleDelayMs?: number
  isSuppressed?: () => SuppressionReason | null
  onShow?: (surveyId: SurveyId) => void
  /** A prompt the user has already dismissed this many times in the session. */
  dismissalCount?: () => number
  maxDismissals?: number
  schedule?: (fn: () => void, ms: number) => void
  clearScheduled?: (handle: unknown) => void
  /** Whether an automatic prompt is currently visible. */
  hasActivePrompt?: () => boolean
  /** Called when a visible automatic prompt must be discarded by suppression. */
  onDiscardActivePrompt?: (reason: SuppressionReason) => void
}

export interface SurveyScheduler {
  request: (surveyId: SurveyId) => ScheduleOutcome
  cancel: (reason: SuppressionReason) => void
  dismiss: () => void
  /** A completion: records the completion, never a dismissal. */
  complete: () => void
  isShownThisSession: () => boolean
  dismissalCount: () => number
  completionCount: () => number
  isPending: () => SurveyId | null
  pendingSuppression: () => SuppressionReason | null
}

interface PendingPrompt {
  surveyId: SurveyId
  timer: unknown
  scheduledAt: number
}

const DEFAULT_IDLE_DELAY_MS = 5000
const DEFAULT_MAX_DISMISSALS = 3

export function createSuppressionTracker(): {
  add: (reason: SuppressionReason) => void
  remove: (reason: SuppressionReason) => void
  isSuppressed: () => SuppressionReason | null
} {
  const active = new Set<SuppressionReason>()
  return {
    add: (reason) => {
      active.add(reason)
    },
    remove: (reason) => {
      active.delete(reason)
    },
    // Deterministic precedence: incident response first, then the others in
    // declaration order, so reporting never depends on Set iteration order.
    isSuppressed: () => {
      for (const reason of SUPPRESSION_REASONS) {
        if (active.has(reason)) return reason
      }
      return null
    },
  }
}

export function createSurveyScheduler(options: SurveySchedulerOptions = {}): SurveyScheduler {
  const idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS
  const isSuppressed = options.isSuppressed ?? (() => null)
  const maxDismissals = options.maxDismissals ?? DEFAULT_MAX_DISMISSALS
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms) as unknown)
  const clearScheduled = options.clearScheduled ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const dismissalCount = options.dismissalCount ?? (() => localDismissals)

  let shownThisSession = false
  let localDismissals = 0
  let localCompletions = 0
  let pending: PendingPrompt | null = null
  let pendingSuppression: SuppressionReason | null = null

  const clearPending = () => {
    if (pending) {
      clearScheduled(pending.timer)
      pending = null
    }
  }

  return {
    request: (surveyId) => {
      clearPending()
      if (shownThisSession) return 'already-shown'
      if (dismissalCount() >= maxDismissals) return 'declined'
      const immediate = isSuppressed()
      if (immediate) {
        // A suppressed request is discarded outright, never deferred.
        return 'suppressed'
      }
      pending = {
        surveyId,
        timer: schedule(() => {
          pending = null
          // Eligibility is rechecked after the idle delay, because the state
          // that suppresses a prompt can change while it waits.
          if (shownThisSession) return
          const suppressed = isSuppressed()
          if (suppressed) {
            pendingSuppression = suppressed
            return
          }
          if (dismissalCount() >= maxDismissals) return
          shownThisSession = true
          options.onShow?.(surveyId)
        }, idleDelayMs),
        scheduledAt: Date.now(),
      }
      return 'delayed'
    },
    cancel: (reason) => {
      clearPending()
      pendingSuppression = reason
      // Suppression discards a prompt that is already visible, not only one
      // still waiting for the idle delay: an incident, a critical alert,
      // unsaved work or a route change never leaves a prompt on screen.
      if (options.hasActivePrompt?.() && options.onDiscardActivePrompt) {
        options.onDiscardActivePrompt(reason)
      }
    },
    dismiss: () => {
      localDismissals += 1
      clearPending()
    },
    complete: () => {
      // A completed survey is not a dismissal and does not count toward the
      // dismissal cap; the one-per-session cap still applies.
      localCompletions += 1
      clearPending()
    },
    isShownThisSession: () => shownThisSession,
    dismissalCount: () => localDismissals,
    completionCount: () => localCompletions,
    isPending: () => pending?.surveyId ?? null,
    pendingSuppression: () => pendingSuppression,
  }
}
