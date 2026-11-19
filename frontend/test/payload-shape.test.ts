// Payload shaping: form values become the backend scalar response object and
// nothing leaves the browser that the contract cannot accept.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEEDBACK_DEFINITIONS,
  feedbackDefinitionFor,
  toFeedbackResponse,
  validateFeedbackValues,
} from '../src/lib/feedback/feedback-definitions.ts'
import {
  SURVEY_DEFINITIONS,
  npsScoreFor,
  surveyDefinitionFor,
  surveyValidationIssues,
  toScalarResponse,
} from '../src/lib/feedback/survey-definitions.ts'

test('every feedback type in the contract has a definition', () => {
  for (const type of ['bug_report', 'feature_request', 'general'] as const) {
    assert.ok(FEEDBACK_DEFINITIONS[type])
    assert.equal(FEEDBACK_DEFINITIONS[type].feedback_type, type)
  }
  assert.equal(feedbackDefinitionFor('bug_report')?.title, 'Report a bug')
  assert.equal(feedbackDefinitionFor('microsurvey'), null)
})

test('no feedback flow carries a screenshot, annotation or email field', () => {
  for (const definition of Object.values(FEEDBACK_DEFINITIONS)) {
    const ids = definition.fields.map((field) => field.id)
    for (const forbidden of ['screenshot', 'annotation', 'email', 'contact', 'similar_request']) {
      assert.equal(ids.includes(forbidden), false, `${definition.feedback_type} exposes ${forbidden}`)
    }
  }
})

test('every survey id in the contract has a definition', () => {
  const ids = [
    'welcome',
    'microsurvey_monitor_created',
    'microsurvey_alert_received',
    'microsurvey_playbook_completed',
    'microsurvey_team_invite',
    'nps_day14',
    'nps_day30',
    'exit_account_delete',
    'exit_inactivity',
  ] as const
  for (const id of ids) {
    assert.ok(SURVEY_DEFINITIONS[id], `missing definition for ${id}`)
    assert.equal(SURVEY_DEFINITIONS[id].id, id)
  }
  assert.equal(surveyDefinitionFor('exit_survey'), null)
});

test('feedback values trim, drop empty optionals and join nothing', () => {
  const mapped = toFeedbackResponse({
    bug_type: 'bug',
    severity: 'critical',
    description: '  The dashboard is empty  ',
    steps_to_reproduce: '   ',
  })
  assert.equal(mapped.ok, true)
  assert.deepEqual(mapped.response, {
    bug_type: 'bug',
    severity: 'critical',
    description: 'The dashboard is empty',
  })
})

test('feedback validation reports required text and single-choice fields', () => {
  const definition = FEEDBACK_DEFINITIONS.bug_report
  const issues = validateFeedbackValues(definition, {})
  assert.equal(issues.length, 3)
  assert.ok(issues.some((issue) => issue.fieldId === 'description'))

  const valid = validateFeedbackValues(definition, {
    bug_type: 'bug',
    severity: 'high',
    description: 'The health card is empty.',
  })
  assert.deepEqual(valid, [])
});

test('oversized free text is rejected before it leaves the browser', () => {
  const mapped = toFeedbackResponse({ description: 'x'.repeat(4001) })
  assert.equal(mapped.ok, false)
  assert.equal(mapped.issues.length, 1)
});

test('survey answers join multi-select arrays into a scalar', () => {
  const mapped = toScalarResponse({
    primary_goal: ['uptime_monitoring', 'error_tracking'],
    apps_to_monitor: '2-5',
    current_setup_other_text: 'Grafana',
  })
  assert.equal(mapped.ok, true)
  assert.equal(mapped.response.primary_goal, 'uptime_monitoring, error_tracking')
  assert.equal(typeof mapped.response.apps_to_monitor, 'string')
  assert.deepEqual(Object.keys(mapped.response).sort(), [
    'apps_to_monitor',
    'current_setup_other_text',
    'primary_goal',
  ])
});

test('non-scalar and oversized survey answers are rejected', () => {
  const nested = toScalarResponse({ answers: { nested: true } as unknown as string })
  assert.equal(nested.ok, false)
  const long = toScalarResponse({ reason: 'x'.repeat(4001) })
  assert.equal(long.ok, false)
});

test('the NPS scale is required and mapped to the allowlisted score', () => {
  const definition = SURVEY_DEFINITIONS.nps_day14
  assert.equal(surveyValidationIssues(definition, {}).length, 1)
  assert.equal(npsScoreFor(definition, {}), undefined)
  assert.equal(npsScoreFor(definition, { score: 7 }), 7)
  // Out-of-range values are ignored rather than sent.
  assert.equal(npsScoreFor(definition, { score: 11 }), undefined)
  assert.equal(npsScoreFor(definition, { score: 'seven' }), undefined)
});

test('a microsurvey has no NPS question and sends no score', () => {
  const definition = SURVEY_DEFINITIONS.microsurvey_monitor_created
  assert.equal(npsScoreFor(definition, { ease: 4 }), undefined)
  assert.deepEqual(surveyValidationIssues(definition, { ease: 4 }), [])
});

test('welcome keeps to segmentation and has no satisfaction question', () => {
  const kinds = SURVEY_DEFINITIONS.welcome.questions.map((question) => question.kind)
  assert.equal(kinds.includes('nps'), false)
  assert.equal(kinds.includes('stars'), false)
  assert.equal(SURVEY_DEFINITIONS.welcome.questions.length, 3)
});
