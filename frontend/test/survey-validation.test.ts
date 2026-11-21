// Survey validation and reachable-flow truthfulness (NOC-340 remediation):
// star, single, multi and NPS questions are required where the definition
// says so; the NPS range rule is applied to the payload; no survey accepts an
// empty submission; nothing without a backend contract is claimed.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SURVEY_DEFINITIONS,
  npsScoreFor,
  surveyValidationIssues,
} from '../src/lib/feedback/survey-definitions.ts'

test('a required star question blocks an empty submission', () => {
  const definition = SURVEY_DEFINITIONS.microsurvey_monitor_created
  assert.equal(definition.questions[0].kind, 'stars')
  const issues = surveyValidationIssues(definition, {})
  assert.equal(issues.length, 1)
  assert.equal(issues[0].questionId, 'ease')
  assert.deepEqual(surveyValidationIssues(definition, { ease: 4 }), [])
  assert.deepEqual(surveyValidationIssues(definition, { ease: 6 }), [
    { questionId: 'ease', message: 'Choose a rating from 1 to 5.' },
  ])
  assert.deepEqual(surveyValidationIssues(definition, { ease: 'four' }), [
    { questionId: 'ease', message: 'Choose a rating from 1 to 5.' },
  ])
})

test('a required single question blocks an empty or unknown choice', () => {
  const definition = SURVEY_DEFINITIONS.microsurvey_playbook_completed
  assert.equal(surveyValidationIssues(definition, {}).length, 1)
  assert.deepEqual(surveyValidationIssues(definition, { outcome: 'fully_resolved' }), [])
  assert.deepEqual(surveyValidationIssues(definition, { outcome: 'magic' }), [
    { questionId: 'outcome', message: 'Choose one option for did the playbook resolve it?.' },
  ])
})

test('a required multi question blocks an empty selection', () => {
  const definition = SURVEY_DEFINITIONS.welcome
  assert.deepEqual(surveyValidationIssues(definition, { apps_to_monitor: '2-5' }).map((i) => i.questionId).sort(), [
    'primary_goal',
  ])
  assert.deepEqual(surveyValidationIssues(definition, { primary_goal: ['uptime_monitoring'], apps_to_monitor: '1' }), [])
})

test('the NPS question is always required and range-checked on the payload', () => {
  for (const id of ['nps_day14', 'nps_day30'] as const) {
    const definition = SURVEY_DEFINITIONS[id]
    assert.equal(surveyValidationIssues(definition, {}).length, 1)
    assert.equal(surveyValidationIssues(definition, { score: 0 }).length, 0)
    assert.equal(surveyValidationIssues(definition, { score: 10 }).length, 0)
    assert.equal(surveyValidationIssues(definition, { score: 11 }).length, 1)
    assert.equal(surveyValidationIssues(definition, { score: -1 }).length, 1)
    assert.equal(surveyValidationIssues(definition, { score: 7.5 }).length, 1)
    // The payload rule matches the validator: out-of-range scores are never
    // mapped to the allowlisted `score` property.
    assert.equal(npsScoreFor(definition, { score: 11 }), undefined)
    assert.equal(npsScoreFor(definition, { score: 0 }), 0)
    assert.equal(npsScoreFor(definition, { score: 10 }), 10)
  }
})

test('exit and inactivity surveys are required and contract-backed', () => {
  const accountDelete = SURVEY_DEFINITIONS.exit_account_delete
  assert.equal(surveyValidationIssues(accountDelete, {}).length, 2)
  assert.deepEqual(
    surveyValidationIssues(accountDelete, { reasons: ['too_expensive'], experience: 4 }).map((i) => i.questionId).sort(),
    []
  )
  const inactivity = SURVEY_DEFINITIONS.exit_inactivity
  assert.equal(surveyValidationIssues(inactivity, {}).length, 1)
  assert.deepEqual(surveyValidationIssues(inactivity, { reasons: ['switching'] }), [])
})

test('no survey definition asks for a screenshot, email or upvote', () => {
  for (const [id, definition] of Object.entries(SURVEY_DEFINITIONS)) {
    for (const question of definition.questions) {
      const label = question.label.toLowerCase()
      for (const forbidden of ['screenshot', 'email', 'upvote', 'similar request', 'annotation']) {
        assert.equal(label.includes(forbidden), false, `${id} asks for ${forbidden}`)
      }
      if (question.kind === 'text') {
        assert.equal(question.placeholder?.toLowerCase().includes('email') ?? false, false, `${id} collects an email`)
      }
    }
  }
})