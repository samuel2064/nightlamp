// Declarative survey definitions mirroring the backend SURVEY_IDS enum.
// Only surfaces the backend response contract supports are defined: no
// screenshot annotation or similar-request behaviour without a contract.

import { isSurveyId, type SurveyId } from './contract'

export type SurveyQuestion =
  | { kind: 'single'; id: string; label: string; options: { value: string; label: string }[] }
  | {
      kind: 'multi'
      id: string
      label: string
      options: { value: string; label: string }[]
      otherId?: string
    }
  | { kind: 'stars'; id: string; label: string; max: number; anchors: [string, string] }
  | { kind: 'nps'; id: string; label: string }
  | { kind: 'text'; id: string; label: string; required?: boolean; placeholder?: string }

export interface SurveyDefinition {
  id: SurveyId
  title: string
  description?: string
  questions: SurveyQuestion[]
  submitLabel?: string
}

const OPTION_GOALS = [
  { value: 'uptime_monitoring', label: 'Uptime monitoring' },
  { value: 'performance_tracking', label: 'Performance tracking' },
  { value: 'error_tracking', label: 'Error tracking' },
  { value: 'dependency_updates', label: 'Dependency updates' },
  { value: 'compliance', label: 'Compliance' },
]

const OPTION_APP_COUNTS = [
  { value: '1', label: '1' },
  { value: '2-5', label: '2-5' },
  { value: '6-20', label: '6-20' },
  { value: '20+', label: '20+' },
]

const OPTION_SETUP = [
  { value: 'none', label: 'None' },
  { value: 'custom_scripts', label: 'Custom scripts' },
  { value: 'datadog', label: 'Datadog' },
  { value: 'new_relic', label: 'New Relic' },
  { value: 'sentry', label: 'Sentry' },
  { value: 'pagerduty', label: 'PagerDuty' },
]

const OPTION_PLAYBOOK_OUTCOME = [
  { value: 'fully_resolved', label: 'Yes, fully resolved' },
  { value: 'partially_helped', label: 'Partially helped' },
  { value: 'manual_fix_needed', label: 'No, manual fix needed' },
]

const OPTION_EXIT_REASONS = [
  { value: 'too_expensive', label: 'Too expensive' },
  { value: 'missing_features', label: 'Missing features' },
  { value: 'switching', label: 'Switching to another tool' },
  { value: 'no_longer_needed', label: 'No longer need monitoring' },
  { value: 'technical_issues', label: 'Technical issues' },
]

export const SURVEY_DEFINITIONS: Record<SurveyId, SurveyDefinition> = {
  welcome: {
    id: 'welcome',
    title: 'Welcome to Nightlamp Beta',
    description: 'Help us build for you. Three quick questions, under a minute.',
    questions: [
      { kind: 'multi', id: 'primary_goal', label: "What's your primary goal?", options: OPTION_GOALS, otherId: 'primary_goal_other' },
      { kind: 'single', id: 'apps_to_monitor', label: 'How many apps do you want to monitor?', options: OPTION_APP_COUNTS },
      { kind: 'multi', id: 'current_setup', label: 'Current monitoring setup?', options: OPTION_SETUP, otherId: 'current_setup_other' },
    ],
    submitLabel: 'Continue',
  },
  microsurvey_monitor_created: {
    id: 'microsurvey_monitor_created',
    title: 'How easy was setup?',
    questions: [{ kind: 'stars', id: 'ease', label: 'How easy was setup?', max: 5, anchors: ['Hard', 'Easy'] }],
  },
  microsurvey_alert_received: {
    id: 'microsurvey_alert_received',
    title: 'How useful was this alert?',
    questions: [{ kind: 'stars', id: 'usefulness', label: 'How useful was this alert?', max: 5, anchors: ['Useless', 'Essential'] }],
  },
  microsurvey_playbook_completed: {
    id: 'microsurvey_playbook_completed',
    title: 'Did the playbook resolve it?',
    questions: [
      { kind: 'single', id: 'outcome', label: 'Did the playbook resolve it?', options: OPTION_PLAYBOOK_OUTCOME },
      { kind: 'text', id: 'details', label: 'Details (optional)', required: false },
    ],
  },
  microsurvey_team_invite: {
    id: 'microsurvey_team_invite',
    title: 'How clear were role permissions?',
    questions: [{ kind: 'stars', id: 'clarity', label: 'How clear were role permissions?', max: 5, anchors: ['Confusing', 'Crystal clear'] }],
  },
  nps_day14: {
    id: 'nps_day14',
    title: 'How likely are you to recommend Nightlamp?',
    description: 'Two quick follow-ups after your score.',
    questions: [
      { kind: 'nps', id: 'score', label: 'How likely are you to recommend Nightlamp?' },
      { kind: 'text', id: 'reason', label: "What's the main reason for your score?", required: false },
      { kind: 'text', id: 'improvement', label: 'What one thing would make Nightlamp a 10?', required: false },
    ],
  },
  nps_day30: {
    id: 'nps_day30',
    title: 'How likely are you to recommend Nightlamp?',
    description: 'Two quick follow-ups after your score.',
    questions: [
      { kind: 'nps', id: 'score', label: 'How likely are you to recommend Nightlamp?' },
      { kind: 'text', id: 'reason', label: "What's the main reason for your score?", required: false },
      { kind: 'text', id: 'improvement', label: 'What one thing would make Nightlamp a 10?', required: false },
    ],
  },
  exit_account_delete: {
    id: 'exit_account_delete',
    title: 'Before you go',
    questions: [
      { kind: 'multi', id: 'reasons', label: 'Why are you leaving?', options: OPTION_EXIT_REASONS, otherId: 'reasons_other' },
      { kind: 'text', id: 'would_stay', label: 'What would have made you stay?', required: false },
      { kind: 'stars', id: 'experience', label: 'Overall experience', max: 5, anchors: ['Poor', 'Excellent'] },
    ],
    submitLabel: 'Submit',
  },
  exit_inactivity: {
    id: 'exit_inactivity',
    title: "Haven't seen you in a while",
    description: 'Everything OK? One minute of feedback helps.',
    questions: [
      { kind: 'multi', id: 'reasons', label: "What's been going on?", options: OPTION_EXIT_REASONS, otherId: 'reasons_other' },
      { kind: 'text', id: 'would_stay', label: 'What would bring you back?', required: false },
    ],
    submitLabel: 'Submit',
  },
}

export function surveyDefinitionFor(id: string): SurveyDefinition | null {
  return isSurveyId(id) ? SURVEY_DEFINITIONS[id] : null
}

export type SurveyAnswers = Record<string, string | number | boolean | string[]>

export interface ScalarViolation {
  questionId: string
  message: string
}

// The backend response contract stores scalars only; arrays are joined into
// comma-separated strings before submission and non-scalars are rejected here.
export function toScalarResponse(answers: SurveyAnswers): {
  ok: boolean
  response: Record<string, string | number | boolean>
  violations: ScalarViolation[]
} {
  const response: Record<string, string | number | boolean> = {}
  const violations: ScalarViolation[] = []
  for (const [key, value] of Object.entries(answers)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      if (typeof value === 'string' && value.length > 4000) {
        violations.push({ questionId: key, message: 'Answer is too long' })
        continue
      }
      response[key] = value
      continue
    }
    if (Array.isArray(value)) {
      response[key] = value
        .map((entry) => (typeof entry === 'string' ? entry : String(entry)))
        .filter((entry) => entry.length > 0)
        .join(', ')
      continue
    }
    violations.push({ questionId: key, message: 'Answer must be text or a number' })
  }
  return { ok: violations.length === 0, response, violations }
}

export function surveyValidationIssues(
  definition: SurveyDefinition,
  answers: SurveyAnswers,
): { questionId: string; message: string }[] {
  const issues: { questionId: string; message: string }[] = []
  for (const question of definition.questions) {
    if (question.kind === 'text' && question.required) {
      const value = answers[question.id]
      if (typeof value !== 'string' || value.trim().length === 0) {
        issues.push({ questionId: question.id, message: `${question.label} is required` })
      }
    }
    // The NPS scale carries the canonical `score` on the survey response, so a
    // submission without it is incomplete rather than merely unscored.
    if (question.kind === 'nps' && typeof answers[question.id] !== 'number') {
      issues.push({ questionId: question.id, message: 'Choose a score from 0 to 10.' })
    }
  }
  const mapped = toScalarResponse(answers)
  for (const violation of mapped.violations) {
    issues.push({ questionId: violation.questionId, message: violation.message })
  }
  return issues
}

// The NPS question is the only scale mapped to the response `score` field
// (0-10, allowlisted on survey_completed). Star ratings stay in the response
// object so analytics never receives a scale it cannot interpret.
export function npsScoreFor(
  definition: SurveyDefinition,
  answers: SurveyAnswers,
): number | undefined {
  const question = definition.questions.find((entry) => entry.kind === 'nps')
  if (!question) return undefined
  const value = answers[question.id]
  return typeof value === 'number' && value >= 0 && value <= 10 ? value : undefined
}
