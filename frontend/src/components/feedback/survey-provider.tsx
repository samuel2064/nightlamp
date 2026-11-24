'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { trpc } from '@/lib/trpc'
import { createSurveyScheduler, createSuppressionTracker, MICROSURVEY_FOR_ACTION, AUTOMATIC_SURVEYS, USER_INITIATED_SURVEYS, type SuppressionReason, type SurveyTriggerAction } from '@/lib/feedback/survey-eligibility'
import { surveyDefinitionFor, type SurveyDefinition } from '@/lib/feedback/survey-definitions'
import type { SurveyId } from '@/lib/feedback/contract'
import { MicrosurveyInline } from './survey-inline'
import { SurveyModal } from './survey-modal'

export { MICROSURVEY_FOR_ACTION }
export type { SurveyTriggerAction } from '@/lib/feedback/survey-eligibility'

// Survey orchestration for the beta surfaces.
//
// Contract (NOC-161 2026-11-16 addendum):
// - automatic surveys appear only after a successful action plus the idle
//   delay, at most one per session, with eligibility rechecked after the delay
// - prompts are suppressed and discarded during an active incident, a critical
//   alert, unsaved work or a route change; suppressed prompts are never queued,
//   and a suppression discards a prompt that is already on screen
// - a completion is never counted as a dismissal
// - user-initiated surfaces (welcome invitation, feedback entry points) bypass
//   this engine entirely and stay available while prompts are suppressed
//
// Reachability, truthfully: every automatic trigger wired in this release is
// backed by a durable server acceptance. Monitor creation, team invitation and
// the day-14/day-30 and exit surveys have no durable action or eligibility
// contract in this release, so nothing schedules them automatically; their
// definitions stay in the contract for parity and the surfaces can still be
// opened user-initiated through openSurvey.

export const MICROSURVEY_IDLE_DELAY_MS = 5_000

export interface SurveySurfacesValue {
  activeSurveyId: SurveyId | null
  isAutomatic: boolean
  /** Why automatic prompts are currently suppressed, for truthful UI/telemetry. */
  suppressionReason: SuppressionReason | null
  /** User-initiated: bypasses the scheduler and every suppression rule. */
  openSurvey: (surveyId: SurveyId) => void
  /** Dismissal: never a completion, never blocks monitoring. */
  dismissSurvey: () => void
  /** Completion: the response was durably accepted. Never a dismissal. */
  completeSurvey: () => void
  /** Call only after a durable server acceptance for the action. */
  reportAction: (action: SurveyTriggerAction) => void
  reportUnsavedWork: (dirty: boolean) => void
  isSuppressed: () => SuppressionReason | null
}

const SurveySurfacesContext = React.createContext<SurveySurfacesValue | null>(null)

export function useSurveySurfaces(): SurveySurfacesValue {
  const value = React.useContext(SurveySurfacesContext)
  if (!value) {
    throw new Error('useSurveySurfaces must be used inside <SurveyProvider>')
  }
  return value
}

/** Convenience hook for wiring durable action successes to the scheduler.
 * Safe to call outside a provider: without one the trigger is a no-op. */
export function useSurveyTrigger() {
  const value = React.useContext(SurveySurfacesContext)
  const reportAction = value?.reportAction
  return React.useMemo(
    () => ({
      alertReceived: () => reportAction?.('alert_received'),
      playbookCompleted: () => reportAction?.('playbook_completed'),
    }),
    [reportAction]
  )
}

/** Unsaved-work suppression is optional wiring: safe outside a provider. */
export function useUnsavedWorkReporter() {
  const value = React.useContext(SurveySurfacesContext)
  const report = value?.reportUnsavedWork
  return React.useCallback((dirty: boolean) => report?.(dirty), [report])
}

interface ActiveSurvey {
  id: SurveyId
  automatic: boolean
}

export function SurveyProvider({ children }: { children: React.ReactNode }) {
  const [active, setActive] = React.useState<ActiveSurvey | null>(null)
  const [suppressionReason, setSuppressionReason] = React.useState<SuppressionReason | null>(null)
  const suppressionRef = React.useRef(createSuppressionTracker())
  const activeRef = React.useRef<ActiveSurvey | null>(null)
  const pathname = usePathname()
  const lastPathname = React.useRef(pathname)

  React.useEffect(() => {
    activeRef.current = active
  }, [active])

  const scheduler = React.useMemo(
    () =>
      createSurveyScheduler({
        idleDelayMs: MICROSURVEY_IDLE_DELAY_MS,
        isSuppressed: () => suppressionRef.current.isSuppressed(),
        hasActivePrompt: () => activeRef.current?.automatic === true,
        onDiscardActivePrompt: () => setActive(null),
        onShow: (surveyId) => setActive({ id: surveyId, automatic: true }),
      }),
    []
  )

  const syncSuppression = React.useCallback(() => {
    setSuppressionReason((prev) => {
      const next = suppressionRef.current.isSuppressed()
      return prev === next ? prev : next
    })
  }, [])

  // Adds a suppression reason and discards any visible or pending automatic
  // prompt when the reason becomes active (one authoritative precedence lives
  // in createSuppressionTracker).
  const applySuppression = React.useCallback(
    (reason: SuppressionReason, dirty: boolean) => {
      const wasActive = suppressionRef.current.isSuppressed()
      if (dirty) suppressionRef.current.add(reason)
      else suppressionRef.current.remove(reason)
      const nowActive = suppressionRef.current.isSuppressed()
      if (dirty && nowActive === reason && wasActive !== reason) {
        // Newly suppressed: discard the prompt entirely, never queue it.
        scheduler.cancel(reason)
      }
      syncSuppression()
    },
    [scheduler, syncSuppression]
  )

  // Active incident / critical alert come from the authenticated incidents
  // feed: an unacknowledged failure event is an incident still being worked.
  const incidentsQuery = trpc.incidents.list.useQuery({ limit: 100 }, { refetchInterval: 30_000 })
  const events = incidentsQuery.data?.events ?? []
  const hasCriticalAlert = events.some((event) => event.severity === 'critical' && !event.acknowledged)
  const hasActiveIncident = events.some((event) => !event.acknowledged)

  React.useEffect(() => {
    applySuppression('critical_alert', hasCriticalAlert)
    applySuppression('incident_response', hasActiveIncident && !hasCriticalAlert)
  }, [hasCriticalAlert, hasActiveIncident, applySuppression])

  // A route change discards a prompt that is still visible and one still
  // waiting for the idle delay.
  React.useEffect(() => {
    if (lastPathname.current === pathname) return
    lastPathname.current = pathname
    scheduler.cancel('route_change')
    syncSuppression()
  }, [pathname, scheduler, syncSuppression])

  const value = React.useMemo<SurveySurfacesValue>(() => {
    return {
      activeSurveyId: active?.id ?? null,
      isAutomatic: active?.automatic ?? false,
      suppressionReason,
      openSurvey: (surveyId) => {
        if (!surveyDefinitionFor(surveyId)) return
        // User-initiated prompts ignore the session cap and suppression.
        setActive({ id: surveyId, automatic: !USER_INITIATED_SURVEYS.includes(surveyId) })
      },
      dismissSurvey: () => {
        setActive((prev) => {
          if (prev?.automatic) scheduler.dismiss()
          return null
        })
      },
      completeSurvey: () => {
        setActive((prev) => {
          if (prev?.automatic) scheduler.complete()
          return null
        })
      },
      reportAction: (action) => {
        const surveyId = MICROSURVEY_FOR_ACTION[action]
        if (!AUTOMATIC_SURVEYS.includes(surveyId)) return
        scheduler.request(surveyId)
      },
      reportUnsavedWork: (dirty) => applySuppression('unsaved_work', dirty),
      isSuppressed: () => suppressionRef.current.isSuppressed(),
    }
  }, [active, scheduler, suppressionReason, applySuppression])

  const definition: SurveyDefinition | null = active ? surveyDefinitionFor(active.id) : null

  return (
    <SurveySurfacesContext.Provider value={value}>
      {children}
      {definition && active?.automatic ? (
        <MicrosurveyInline
          definition={definition}
          open
          onDismiss={value.dismissSurvey}
          onSent={value.completeSurvey}
        />
      ) : null}
      {definition && !active?.automatic ? (
        <SurveyModal definition={definition} open onDismiss={value.dismissSurvey} onSent={value.completeSurvey} />
      ) : null}
    </SurveySurfacesContext.Provider>
  )
}