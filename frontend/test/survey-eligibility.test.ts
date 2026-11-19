// Automatic survey eligibility rules (NOC-161 2026-11-16 addendum):
// after a successful action plus the idle delay, at most one per session,
// eligibility rechecked after the delay, suppressed prompts discarded not
// queued, and user-initiated prompts unaffected.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPRESSION_REASONS,
  createSuppressionTracker,
  createSurveyScheduler,
  type SuppressionReason,
} from '../src/lib/feedback/survey-eligibility.ts'

interface Harness {
  scheduler: ReturnType<typeof createSurveyScheduler>
  shown: string[]
  advance: (ms: number) => void
  isSuppressed: () => SuppressionReason | null
}

function harness(options: {
  suppressed?: () => SuppressionReason | null
  idleDelayMs?: number
  maxDismissals?: number
} = {}): Harness {
  const timers: { fn: () => void; at: number }[] = []
  let clock = 0
  const shown: string[] = []

  const scheduler = createSurveyScheduler({
    idleDelayMs: options.idleDelayMs ?? 5000,
    isSuppressed: options.suppressed ?? (() => null),
    maxDismissals: options.maxDismissals,
    schedule: (fn, ms) => {
      const handle = { fn, at: clock + ms }
      timers.push(handle)
      return handle
    },
    clearScheduled: (handle) => {
      const index = timers.indexOf(handle as { fn: () => void; at: number })
      if (index >= 0) timers.splice(index, 1)
    },
    onShow: (surveyId) => shown.push(surveyId),
  })

  return {
    scheduler,
    shown,
    advance: (ms) => {
      clock += ms
      const due = timers.filter((timer) => timer.at <= clock)
      for (const timer of due) {
        const index = timers.indexOf(timer)
        timers.splice(index, 1)
        timer.fn()
      }
    },
    isSuppressed: options.suppressed ?? (() => null),
  }
}

test('a request waits for the idle delay and then shows once per session', () => {
  const h = harness()
  assert.equal(h.scheduler.request('microsurvey_monitor_created'), 'delayed')
  assert.equal(h.scheduler.isPending(), 'microsurvey_monitor_created')
  assert.deepEqual(h.shown, [])

  h.advance(5000)
  assert.deepEqual(h.shown, ['microsurvey_monitor_created'])
  assert.equal(h.scheduler.isShownThisSession(), true)

  // At most one automatic survey per session.
  assert.equal(h.scheduler.request('microsurvey_alert_received'), 'already-shown')
  h.advance(10000)
  assert.deepEqual(h.shown, ['microsurvey_monitor_created'])
})

test('a request made while suppressed is discarded, never queued', () => {
  let reason: SuppressionReason | null = 'critical_alert'
  const h = harness({ suppressed: () => reason })
  assert.equal(h.scheduler.request('microsurvey_monitor_created'), 'suppressed')
  assert.equal(h.scheduler.isPending(), null)

  reason = null
  h.advance(10000)
  assert.deepEqual(h.shown, [])
})

test('eligibility is rechecked after the idle delay', () => {
  let reason: SuppressionReason | null = null
  const h = harness({ suppressed: () => reason })
  assert.equal(h.scheduler.request('microsurvey_playbook_completed'), 'delayed')

  // An incident starts while the prompt waits: the prompt is discarded.
  reason = 'incident_response'
  h.advance(5000)
  assert.deepEqual(h.shown, [])
  assert.equal(h.scheduler.isShownThisSession(), false)
  assert.equal(h.scheduler.pendingSuppression(), 'incident_response')

  // A later request is still eligible once the incident is handled.
  reason = null
  assert.equal(h.scheduler.request('microsurvey_playbook_completed'), 'delayed')
  h.advance(5000)
  assert.deepEqual(h.shown, ['microsurvey_playbook_completed'])
})

test('three dismissals decline further automatic prompts', () => {
  const h = harness()
  h.scheduler.dismiss()
  h.scheduler.dismiss()
  assert.equal(h.scheduler.request('microsurvey_monitor_created'), 'delayed')
  h.advance(5000)
  assert.deepEqual(h.shown, ['microsurvey_monitor_created'])
})

test('a cancelled prompt is discarded and re-requested later', () => {
  const h = harness()
  h.scheduler.request('microsurvey_monitor_created')
  h.scheduler.cancel('route_change')
  assert.equal(h.scheduler.isPending(), null)
  assert.equal(h.scheduler.pendingSuppression(), 'route_change')
  h.advance(10000)
  assert.deepEqual(h.shown, [])
})

test('suppression precedence is deterministic', () => {
  const tracker = createSuppressionTracker()
  tracker.add('route_change')
  tracker.add('unsaved_work')
  assert.equal(tracker.isSuppressed(), 'unsaved_work')
  tracker.add('critical_alert')
  assert.equal(tracker.isSuppressed(), 'critical_alert')
  tracker.add('incident_response')
  assert.equal(tracker.isSuppressed(), 'incident_response')
  tracker.remove('incident_response')
  assert.equal(tracker.isSuppressed(), 'critical_alert')
  tracker.remove('critical_alert')
  assert.equal(tracker.isSuppressed(), 'unsaved_work')
  tracker.remove('unsaved_work')
  tracker.remove('route_change')
  assert.equal(tracker.isSuppressed(), null)
})

test('the four suppression reasons are the contracted ones', () => {
  assert.deepEqual([...SUPPRESSION_REASONS], [
    'incident_response',
    'critical_alert',
    'unsaved_work',
    'route_change',
  ])
})
