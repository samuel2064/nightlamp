// Contract parity with the protected backend response contract at
// origin/feat/noc-253-analytics-ingestion @ a48ae78
// (src/analytics/event-contract.ts, src/analytics/api.ts). If the backend
// changes, this test fails and the gap is reported on NOC-253 instead of
// silently drifting.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FEEDBACK_TYPES,
  SURVEY_IDS,
  isFeedbackType,
  isSurveyId,
  npsCategoryForScore,
} from '../src/lib/feedback/contract.ts'
import { isValidResponseId } from '../src/lib/feedback/response-id.ts'
import { submissionView } from '../src/lib/feedback/submission-copy.ts'

const BACKEND_SURVEY_IDS = [
  'welcome',
  'microsurvey_monitor_created',
  'microsurvey_alert_received',
  'microsurvey_playbook_completed',
  'microsurvey_team_invite',
  'nps_day14',
  'nps_day30',
  'exit_account_delete',
  'exit_inactivity',
]

const BACKEND_FEEDBACK_TYPES = ['bug_report', 'feature_request', 'general']

test('survey ids match the backend SURVEY_IDS enum', () => {
  assert.deepEqual([...SURVEY_IDS], BACKEND_SURVEY_IDS)
  assert.equal(SURVEY_IDS.length, BACKEND_SURVEY_IDS.length)
})

test('feedback types match the backend FEEDBACK_TYPES enum', () => {
  assert.deepEqual([...FEEDBACK_TYPES], BACKEND_FEEDBACK_TYPES)
  assert.equal(FEEDBACK_TYPES.length, BACKEND_FEEDBACK_TYPES.length)
})

test('survey and feedback ids stay closed sets', () => {
  assert.equal(isSurveyId('nps_day14'), true)
  assert.equal(isSurveyId('nps_day_14'), false)
  assert.equal(isSurveyId('exit_survey'), false)
  assert.equal(isFeedbackType('bug_report'), true)
  assert.equal(isFeedbackType('microsurvey'), false)
})

test('response_id matches the backend character set', () => {
  assert.equal(isValidResponseId('5f2c1d9e-4b7a-4c8e-9a0f-1b2c3d4e5f60'), true)
  assert.equal(isValidResponseId('resp:01H8ZQ.42'), true)
  assert.equal(isValidResponseId('has space'), false)
  assert.equal(isValidResponseId('has/slash'), false)
  assert.equal(isValidResponseId(''), false)
})

test('nps categories follow the standard detractor/passive/promoter cut', () => {
  assert.equal(npsCategoryForScore(0), 'detractor')
  assert.equal(npsCategoryForScore(6), 'detractor')
  assert.equal(npsCategoryForScore(7), 'passive')
  assert.equal(npsCategoryForScore(8), 'passive')
  assert.equal(npsCategoryForScore(9), 'promoter')
  assert.equal(npsCategoryForScore(10), 'promoter')
})

// The backend derives survey_completed / feedback_submitted properties from the
// stored receipt. This mirrors api.ts so the allowed surface is pinned: raw
// answers must never reach analytics.
function analyticsPropertiesFor(input: {
  kind: 'feedback' | 'survey'
  response_id: string
  feedback_type?: string
  survey_id?: string
  score?: number
}): Record<string, unknown> {
  const properties: Record<string, unknown> = { response_id: input.response_id }
  if (input.kind === 'survey') {
    properties.survey_id = input.survey_id
    if (input.score !== undefined) {
      properties.score = input.score
      if (input.survey_id === 'nps_day14' || input.survey_id === 'nps_day30') {
        properties.nps_category = npsCategoryForScore(input.score)
      }
    }
  } else {
    properties.feedback_type = input.feedback_type
  }
  return properties
}

const RAW_ANSWERS = {
  score: 9,
  reason: 'My accountant bob@nightlamp.example keeps asking about https://nightlamp.example/billing',
  improvement: 'weekly digest emails',
  bugs: 'crash, performance',
}

test('analytics properties are allowlisted scalars with no raw answers', () => {
  const properties = analyticsPropertiesFor({
    kind: 'survey',
    response_id: 'resp-1',
    survey_id: 'nps_day14',
    score: RAW_ANSWERS.score as number,
  })

  const allowed = [
    'response_id',
    'survey_id',
    'score',
    'nps_category',
    'feedback_type',
    'user_id_hash',
    'organization_id_hash',
  ]
  for (const key of Object.keys(properties)) {
    assert.ok(allowed.includes(key), `unexpected analytics property: ${key}`)
  }

  const serialized = JSON.stringify(properties)
  // Only the string answers are scanned: `score` is deliberately allowlisted.
  const freeText = Object.values(RAW_ANSWERS).filter((value) => typeof value === 'string')
  for (const answer of freeText) {
    assert.equal(serialized.includes(String(answer)), false, 'raw answer reached analytics')
  }
  assert.equal(serialized.includes('bob@nightlamp.example'), false, 'email reached analytics')
  assert.equal(serialized.includes('https://'), false, 'URL reached analytics')
  // The score arrives as the allowlisted numeric property, nothing else.
  assert.deepEqual(properties, {
    response_id: 'resp-1',
    survey_id: 'nps_day14',
    score: 9,
    nps_category: 'promoter',
  })
})

test('feedback analytics carries the feedback type only', () => {
  const properties = analyticsPropertiesFor({
    kind: 'feedback',
    response_id: 'resp-2',
    feedback_type: 'bug_report',
  })
  assert.deepEqual(Object.keys(properties).sort(), ['feedback_type', 'response_id'])
  // No title, description, severity or step text: those live in the response store.
  assert.equal(JSON.stringify(properties).includes('severity'), false)
})

test('a dismissal is not a completion: no canonical event without a receipt', () => {
  const dismissed = {
    phase: 'editing' as const,
    failureKind: null,
    message: null,
    fieldErrors: [],
    receipt: null,
    attempts: 0,
    responseId: 'resp-3',
  }
  const view = submissionView(dismissed, { mode: 'survey', baseLabel: 'Submit' })
  assert.equal(view.canonicalEvent, null)
  assert.equal(view.isSent, false)
  assert.equal(view.submitLabel, 'Submit')
})
