'use client'

import * as React from 'react'
import { usePathname } from 'next/navigation'
import { trpc } from '@/lib/trpc'
import { createSurveyScheduler, createSuppressionTracker, type SuppressionReason } from '@/lib/feedback/survey-eligibility'
import { surveyDefinitionFor, type SurveyDefinition } from '@/lib/feedback/survey-definitions'
import type { SurveyId } from '@/lib/feedback/contract'
import { MicrosurveyInline } from './survey-inline'
import { SurveyModal } from './survey-modal'

// Survey orchestration for the beta surfaces.
//
// Contract (NOC-161 2026-11-16 addendum):
// - automatic surveys appear only after a successful action plus the idle
//   delay, at most one per session, with eligibility rechecked after the delay
// - prompts are suppressed and discarded during an active incident, a critical
//   alert, unsaved work or a route change; suppressed prompts are never queued
// - user-initiated surfaces (welcome invitation, feedback entry points) bypass
//   this engine entirely and stay available while prompts are suppressed
// - dismissals are never completions

export const MICROSURVEY_IDLE_DELAY_MS = 5_000

export type SurveyTriggerAction = 'monitor_created' | 'alert_received' | 'playbook_completed'

export const MICROSURVEY_FOR_ACTION: Record<SurveyTriggerAction, SurveyId> = {
  monitor_created: 'microsurvey_monitor_created',
  alert_received: 'microsurvey_alert_received',
  playbook_completed: 'microsurvey_playbook_completed',
}

/** Surveys the user opens themselves: modal, focus-contained surfaces. */
const USER_INITIATED_SURVEYS: readonly SurveyId[] = [
  'welcome',
  'nps_day14',
  'nps_day30',
  'exit_account_delete',
  'exit_inactivity',
]

/** Surveys the scheduler may open after a successful action: inline prompts. */
const AUTOMATIC_SURVEYS: readonly SurveyId[] = [
  'microsurvey_monitor_created',
  'microsurvey_alert_received',
  'microsurvey_playbook_completed',
]

export interface SurveySurfacesValue {
  activeSurveyId: SurveyId | null
  isAutomatic: boolean
  /** Why automatic prompts are currently suppressed, for truthful UI/telemetry. */
  suppressionReason: SuppressionReason | null
  /** User-initiated: bypasses the scheduler and every suppression rule. */
  openSurvey: (surveyId: SurveyId) => void
  /** Dismissal: never a completion, never blocks monitoring. */
  dismissSurvey: () => void
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
      monitorCreated: () => reportAction?.('monitor_created'),
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
  const pathname = usePathname()
  const lastPathname = React.useRef(pathname)

  const scheduler = React.useMemo(
    () =>
      createSurveyScheduler({
        idleDelayMs: MICROSURVEY_IDLE_DELAY_MS,
        isSuppressed: () => suppressionRef.current.isSuppressed(),
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

  // Active incident / critical alert come from the authenticated incidents
  // feed: an unacknowledged failure event is an incident still being worked.
  const incidentsQuery = trpc.incidents.list.useQuery({ limit: 100 }, { refetchInterval: 30_000 })
  const events = incidentsQuery.data?.events ?? []
  const hasCriticalAlert = events.some((event) => event.severity === 'critical' && !event.acknowledged)
  const hasActiveIncident = events.some((event) => !event.acknowledged)

  React.useEffect(() => {
    if (hasCriticalAlert) suppressionRef.current.add('critical_alert')
    else suppressionRef.current.remove('critical_alert')
    if (hasActiveIncident && !hasCriticalAlert) suppressionRef.current.add('incident_response')
    else suppressionRef.current.remove('incident_response')
    syncSuppression()
  }, [hasCriticalAlert, hasActiveIncident, syncSuppression])

  // A route change discards a prompt that is still waiting for the idle delay.
  React.useEffect(() => {
    if (lastPathname.current === pathname) return
    lastPathname.current = pathname
    scheduler.cancel('route_change')
  }, [pathname, scheduler])

  const value = React.useMemo<SurveySurfacesValue>(() => {
    const setSuppression = (reason: SuppressionReason, dirty: boolean) => {
      if (dirty) suppressionRef.current.add(reason)
      else suppressionRef.current.remove(reason)
      syncSuppression()
    }
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
      reportAction: (action) => {
        const surveyId = MICROSURVEY_FOR_ACTION[action]
        if (!AUTOMATIC_SURVEYS.includes(surveyId)) return
        scheduler.request(surveyId)
      },
      reportUnsavedWork: (dirty) => setSuppression('unsaved_work', dirty),
      isSuppressed: () => suppressionRef.current.isSuppressed(),
    }
  }, [active, scheduler, suppressionReason, syncSuppression])

  const definition: SurveyDefinition | null = active ? surveyDefinitionFor(active.id) : null

  return (
    <SurveySurfacesContext.Provider value={value}>
      {children}
      {definition && active?.automatic ? (
        <MicrosurveyInline
          definition={definition}
          open
          onDismiss={value.dismissSurvey}
          onSent={value.dismissSurvey}
        />
      ) : null}
      {definition && !active?.automatic ? (
        <SurveyModal definition={definition} open onDismiss={value.dismissSurvey} onSent={value.dismissSurvey} />
      ) : null}
    </SurveySurfacesContext.Provider>
  )
}
