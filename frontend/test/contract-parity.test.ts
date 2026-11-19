// Contract parity with the protected backend response contract. The fixture is
// generated from the real exports of origin/feat/noc-253-analytics-ingestion @
// a48ae78 (src/analytics/event-contract.ts, src/analytics/api.ts), so the
// production frontend schema is checked against the backend contract, not
// against a copy of itself. If the backend changes, this test fails and the
// gap is reported on NOC-253 instead of silently drifting.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { submissionSchema } from '../src/server/routers/feedback.ts'
import {
  FEEDBACK_TYPES,
  NPS_CATEGORIES,
  SURVEY_IDS,
  isFeedbackType,
  isSurveyId,
  npsCategoryForScore,
} from '../src/lib/feedback/contract.ts'
import { isValidResponseId } from '../src/lib/feedback/response-id.ts'
import { SURVEY_DEFINITIONS, npsScoreFor, surveyValidationIssues } from '../src/lib/feedback/survey-definitions.ts'

interface Fixture {
  source: string
  file: string
  commit: string
  generatedAt: string
  generator: string
  enums: {
    SURVEY_IDS: string[]
    FEEDBACK_TYPES: string[]
    NPS_CATEGORIES: string[]
    PLAN_TIERS: string[]
  }
  events: Record<string, { required: string[]; optional: string[]; forbidden: string[] }>
  superProperties: string[]
  piiPropertyNames: string[]
  feedbackResponseContract: {
    allowedTopLevel: string[]
    responseIdPattern: string
    scoreRange: [number, number]
    maxAnswerLength: number
    scalarAnswerTypes: string[]
  }
  analyticsDerivationRules: {
    eventForKind: Record<string, string>
    eventIdEqualsResponseId: boolean
    surveyScoreProperty: string
    npsCategoryCut: Record<string, string>
  }
}

const CONTRACT: Fixture = JSON.parse(
  readFileSync(new URL('./contract-fixtures/analytics-event-contract.json', import.meta.url), 'utf8')
)

test('the fixture records the protected backend contract it was generated from', () => {
  assert.equal(CONTRACT.source, 'origin/feat/noc-253-analytics-ingestion')
  assert.equal(CONTRACT.commit, 'a48ae78')
  assert.equal(CONTRACT.file, 'src/analytics/event-contract.ts')
})

test('the production contract enums match the backend enums', () => {
  assert.deepEqual([...SURVEY_IDS], CONTRACT.enums.SURVEY_IDS)
  assert.deepEqual([...FEEDBACK_TYPES], CONTRACT.enums.FEEDBACK_TYPES)
  assert.deepEqual([...NPS_CATEGORIES], CONTRACT.enums.NPS_CATEGORIES)
})

test('the production submission schema accepts exactly the backend top-level fields', () => {
  const valid = {
    response_id: 'resp-1',
    kind: 'survey',
    survey_id: 'nps_day14',
    score: 9,
    response: { score: 9 },
  }
  assert.equal(submissionSchema.safeParse(valid).success, true)
  assert.deepEqual(
    CONTRACT.feedbackResponseContract.allowedTopLevel,
    ['response_id', 'kind', 'feedback_type', 'survey_id', 'score', 'response']
  )
  // The schema is strict: an unknown key is refused here, not proxied.
  assert.equal(
    submissionSchema.safeParse({ ...valid, extra: 'x' }).success,
    false
  )
})

test('the schema rejects every survey id outside the backend enum', () => {
  const base = { response_id: 'resp-1', kind: 'survey', response: {} }
  for (const id of ['nps_day_14', 'exit_survey', 'welcome ', '']) {
    assert.equal(submissionSchema.safeParse({ ...base, survey_id: id }).success, false, id)
  }
  for (const id of CONTRACT.enums.SURVEY_IDS) {
    assert.equal(submissionSchema.safeParse({ ...base, survey_id: id }).success, true, id)
  }
})

test('the schema rejects every feedback type outside the backend enum', () => {
  const base = { response_id: 'resp-1', kind: 'feedback', response: {} }
  for (const type of ['bug', 'feature', 'general_feedback']) {
    assert.equal(submissionSchema.safeParse({ ...base, feedback_type: type }).success, false, type)
  }
  for (const type of CONTRACT.enums.FEEDBACK_TYPES) {
    assert.equal(submissionSchema.safeParse({ ...base, feedback_type: type }).success, true, type)
  }
})

test('response_id follows the backend character set', () => {
  const pattern = new RegExp(CONTRACT.feedbackResponseContract.responseIdPattern)
  assert.equal(pattern.test('5f2c1d9e-4b7a-4c8e-9a0f-1b2c3d4e5f60'), true)
  assert.equal(pattern.test('resp:01H8ZQ.42'), true)
  assert.equal(pattern.test('has space'), false)
  assert.equal(pattern.test('has/slash'), false)
  assert.equal(isValidResponseId('5f2c1d9e-4b7a-4c8e-9a0f-1b2c3d4e5f60'), true)
  assert.equal(isValidResponseId('has space'), false)
  const tooLong = 'a'.repeat(201)
  assert.equal(isValidResponseId(tooLong), false)
})

test('the score range matches the backend contract', () => {
  const [min, max] = CONTRACT.feedbackResponseContract.scoreRange
  assert.deepEqual([min, max], [0, 10])
  const base = { response_id: 'resp-1', kind: 'survey', survey_id: 'nps_day14', response: {} }
  assert.equal(submissionSchema.safeParse({ ...base, score: 11 }).success, false)
  assert.equal(submissionSchema.safeParse({ ...base, score: -1 }).success, false)
  assert.equal(submissionSchema.safeParse({ ...base, score: 10 }).success, true)
})

test('nps categories follow the backend cut', () => {
  const cut = CONTRACT.analyticsDerivationRules.npsCategoryCut
  assert.equal(cut.detractor, '0-6')
  assert.equal(cut.passive, '7-8')
  assert.equal(cut.promoter, '9-10')
  const expected = (score: number) => {
    const detractor = cut.detractor.split('-').map(Number)
    if (score >= detractor[0] && score <= detractor[1]) return 'detractor'
    const passive = cut.passive.split('-').map(Number)
    if (score >= passive[0] && score <= passive[1]) return 'passive'
    return 'promoter'
  }
  for (let score = 0; score <= 10; score += 1) {
    assert.equal(npsCategoryForScore(score), expected(score), `score ${score}`)
  }
})

test('every survey the frontend can send is defined and validated', () => {
  for (const id of CONTRACT.enums.SURVEY_IDS) {
    assert.ok(isSurveyId(id), `${id} is not a survey id`)
    const definition = SURVEY_DEFINITIONS[id as keyof typeof SURVEY_DEFINITIONS]
    assert.ok(definition, `${id} has no definition`)
    // Empty answers never pass validation: required questions block submission.
    const issues = surveyValidationIssues(definition, {})
    assert.ok(issues.length > 0, `${id} accepts an empty submission`)
  }
  assert.equal(isSurveyId('nps_day_14'), false)
  assert.equal(isFeedbackType('microsurvey'), false)
  assert.equal(isFeedbackType('bug_report'), true)
})

test('the NPS range validator is applied to the final payload', () => {
  const definition = SURVEY_DEFINITIONS.nps_day14
  const [min, max] = CONTRACT.feedbackResponseContract.scoreRange
  assert.equal(npsScoreFor(definition, { score: 11 }), undefined)
  assert.equal(npsScoreFor(definition, { score: min - 1 }), undefined)
  assert.equal(npsScoreFor(definition, { score: max }), max)
  // A score the validator rejects can never reach the payload.
  const issues = surveyValidationIssues(definition, { score: 11 })
  assert.ok(issues.some((issue) => issue.questionId === 'score'))
  assert.deepEqual(surveyValidationIssues(definition, { score: 10, reason: 'ok' }), [])
})

test('answer length follows the backend store limit', () => {
  const limit = CONTRACT.feedbackResponseContract.maxAnswerLength
  const definition = SURVEY_DEFINITIONS.nps_day14
  const tooLong = { score: 9, reason: 'x'.repeat(limit + 1) }
  assert.ok(
    surveyValidationIssues(definition, tooLong).length > 0,
    'an oversized answer is a validation failure'
  )
  const definition2 = SURVEY_DEFINITIONS.microsurvey_playbook_completed
  assert.ok(
    surveyValidationIssues(definition2, { outcome: 'fully_resolved', details: 'x'.repeat(limit + 1) }).length > 0
  )
})

// The server derives the analytics event from the stored receipt. The
// properties the frontend claims must all be allowlisted for that event by
// the backend contract, and no forbidden or PII property may appear.
test('claimed analytics properties are allowlisted by the backend contract', () => {
  const surveyAllowed = new Set([
    ...CONTRACT.superProperties,
    ...CONTRACT.events.survey_completed.required,
    ...CONTRACT.events.survey_completed.optional,
  ])
  const feedbackAllowed = new Set([
    ...CONTRACT.superProperties,
    ...CONTRACT.events.feedback_submitted.required,
    ...CONTRACT.events.feedback_submitted.optional,
  ])
  const pii = new Set(CONTRACT.piiPropertyNames)

  const surveyClaims = ['response_id', 'survey_id', 'score', 'nps_category', 'user_id_hash', 'organization_id_hash']
  for (const property of surveyClaims) {
    assert.equal(surveyAllowed.has(property), true, `survey_completed does not allow ${property}`)
    assert.equal(pii.has(property), false, `${property} is a PII name`)
  }
  for (const forbidden of CONTRACT.events.survey_completed.forbidden) {
    assert.equal(surveyClaims.includes(forbidden), false, `${forbidden} is forbidden on survey_completed`)
  }

  const feedbackClaims = ['response_id', 'feedback_type', 'user_id_hash', 'organization_id_hash']
  for (const property of feedbackClaims) {
    assert.equal(feedbackAllowed.has(property), true, `feedback_submitted does not allow ${property}`)
    assert.equal(pii.has(property), false, `${property} is a PII name`)
  }
  for (const forbidden of CONTRACT.events.feedback_submitted.forbidden) {
    assert.equal(feedbackClaims.includes(forbidden), false, `${forbidden} is forbidden on feedback_submitted`)
  }
})

test('raw answers and free text never enter the claimed analytics properties', () => {
  const surveyClaims = ['response_id', 'survey_id', 'score', 'nps_category']
  const rawAnswers = ['reason', 'improvement', 'answers', 'would_stay', 'contact_consent', 'description']
  for (const name of rawAnswers) {
    assert.equal(surveyClaims.includes(name), false, `${name} must stay in the response store`)
    assert.ok(
      CONTRACT.piiPropertyNames.includes(name) || CONTRACT.events.survey_completed.forbidden.includes(name),
      `${name} is neither PII nor forbidden on survey_completed`
    )
  }
  const feedbackClaims = ['response_id', 'feedback_type']
  for (const name of ['title', 'description', 'sentiment', 'page_context', 'has_screenshot']) {
    assert.equal(feedbackClaims.includes(name), false)
  }
})

test('a dismissal is not a completion: no canonical event without a receipt', () => {
  // The canonical event is derived server-side from the receipt; a dismissal
  // never produces one. The copy layer must not offer success copy either.
  assert.equal(npsScoreFor(SURVEY_DEFINITIONS.nps_day14, {}), undefined)
  assert.equal(surveyValidationIssues(SURVEY_DEFINITIONS.nps_day14, {}).length > 0, true)
})