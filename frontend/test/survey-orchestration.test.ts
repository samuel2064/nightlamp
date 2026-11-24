// Survey orchestration accounting (NOC-340 remediation): a completion is never
// counted as a dismissal, and a suppression discards a prompt that is already
// visible - not only one still waiting for the idle delay.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AUTOMATIC_SURVEYS,
  MICROSURVEY_FOR_ACTION,
  USER_INITIATED_SURVEYS,
  createSurveyScheduler,
} from '../src/lib/feedback/survey-eligibility.ts'
import { SURVEY_DEFINITIONS, surveyDefinitionFor } from '../src/lib/feedback/survey-definitions.ts'
import { SURVEY_IDS } from '../src/lib/feedback/contract.ts'

function schedulerHarness(
  options: { hasActivePrompt?: () => boolean } = {},
): ReturnType<typeof createSurveyScheduler> & { shown: string[] } {
  const shown: string[] = []
  const discardCalls: unknown[] = []
  const scheduler = createSurveyScheduler({
    idleDelayMs: 1,
    schedule: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearScheduled: () => {},
    hasActivePrompt: options.hasActivePrompt,
    onDiscardActivePrompt: (reason) => discardCalls.push(reason),
    onShow: (surveyId) => shown.push(surveyId),
  })
  return Object.assign(scheduler, { shown, discardCalls }) as never
}

test('a completed survey is not a dismissal and keeps the session cap', async () => {
  const h = schedulerHarness()
  assert.equal(h.request('microsurvey_alert_received'), 'delayed')
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(h.shown, ['microsurvey_alert_received'])

  h.complete()
  assert.equal(h.dismissalCount(), 0)
  assert.equal(h.completionCount(), 1)
  assert.equal(h.isShownThisSession(), true)
  // The one-per-session cap still holds after a completion.
  assert.equal(h.request('microsurvey_alert_received'), 'already-shown')
})

test('a dismissal is counted; a completion is not; three dismissals decline', async () => {
  const h = schedulerHarness()
  h.dismiss()
  h.dismiss()
  assert.equal(h.dismissalCount(), 2)
  h.complete()
  assert.equal(h.dismissalCount(), 2)
  h.dismiss()
  assert.equal(h.dismissalCount(), 3)
  assert.equal(h.request('microsurvey_monitor_created'), 'declined')
  assert.deepEqual(h.shown, [])
})

test('suppression discards a prompt that is already visible', () => {
  const discardCalls: string[] = []
  let promptVisible = false
  // Mirrors the provider: discarding the prompt clears the active state, so
  // the next suppression has nothing visible to discard.
  const scheduler = createSurveyScheduler({
    idleDelayMs: 1,
    schedule: (fn, ms) => setTimeout(fn, ms) as unknown,
    clearScheduled: () => {},
    hasActivePrompt: () => promptVisible,
    onDiscardActivePrompt: (reason) => {
      discardCalls.push(reason)
      promptVisible = false
    },
  })

  // A visible automatic prompt is discarded by a new suppression state.
  promptVisible = true
  scheduler.cancel('incident_response')
  assert.deepEqual(discardCalls, ['incident_response'])

  // With nothing visible, the same suppression only records the reason.
  scheduler.cancel('critical_alert')
  assert.deepEqual(discardCalls, ['incident_response'])
  assert.equal(scheduler.pendingSuppression(), 'critical_alert')
})

test('every automatic trigger is backed by a durable action in this release', () => {
  // The claimed automatic surface: alert acknowledgement (durable backend
  // acknowledgement) and playbook decision (durable execution decision).
  assert.deepEqual(Object.keys(MICROSURVEY_FOR_ACTION).sort(), [
    'alert_received',
    'playbook_completed',
  ])
  for (const [action, surveyId] of Object.entries(MICROSURVEY_FOR_ACTION)) {
    assert.ok(AUTOMATIC_SURVEYS.includes(surveyId), `${action} maps outside the automatic set`)
    assert.ok(surveyDefinitionFor(surveyId), `${surveyId} has no definition`)
  }
  // No trigger is wired for monitor-created, team-invite or the exit surveys:
  // no durable action or eligibility contract backs them in this release.
  assert.equal(
    Object.values(MICROSURVEY_FOR_ACTION).includes('microsurvey_monitor_created'),
    false
  )
})

test('every survey definition exists in the backend contract and is renderable', () => {
  assert.deepEqual(Object.keys(SURVEY_DEFINITIONS).sort(), [...SURVEY_IDS].sort())
  for (const id of SURVEY_IDS) {
    const definition = surveyDefinitionFor(id)
    assert.ok(definition, `${id} has no definition`)
    assert.ok(definition.title.length > 0, `${id} has no title`)
    assert.ok(definition.questions.length > 0, `${id} has no questions`)
  }
})

test('user-initiated surveys are exactly the openable surface set', () => {
  // The welcome invitation is the only user-initiated survey a surface opens
  // unconditionally today; the rest stay reachable through openSurvey without
  // an eligibility contract.
  assert.ok(USER_INITIATED_SURVEYS.includes('welcome'))
  for (const id of USER_INITIATED_SURVEYS) {
    assert.ok(surveyDefinitionFor(id), `${id} has no definition`)
    assert.equal(AUTOMATIC_SURVEYS.includes(id), false, `${id} must not be automatic`)
  }
})