export const NPS_CATEGORIES = ['detractor', 'passive', 'promoter'] as const

export type NpsCategory = (typeof NPS_CATEGORIES)[number]

export const FEEDBACK_TYPES = ['bug_report', 'feature_request', 'general'] as const

export type FeedbackType = (typeof FEEDBACK_TYPES)[number]

export const SURVEY_IDS = [
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

export type SurveyId = (typeof SURVEY_IDS)[number]

export function isSurveyId(value: string): value is SurveyId {
  return (SURVEY_IDS as readonly string[]).includes(value)
}

export function isFeedbackType(value: string): value is FeedbackType {
  return (FEEDBACK_TYPES as readonly string[]).includes(value)
}

export function npsCategoryForScore(score: number): NpsCategory {
  if (score <= 6) return 'detractor'
  if (score <= 8) return 'passive'
  return 'promoter'
}

export interface FeedbackSubmission {
  response_id: string
  kind: 'feedback' | 'survey'
  feedback_type?: FeedbackType
  survey_id?: SurveyId
  score?: number
  response: Record<string, string | number | boolean>
}

export interface FeedbackReceipt {
  success: boolean
  duplicate: boolean
  response_id: string
  event_id: string
  event: 'survey_completed' | 'feedback_submitted'
  received_at: string
  forward_status?: string
}

/**
 * Safe metadata-only view of a stored response, served by the frontend receipt
 * route. The raw backend record carries the raw answers, team and user
 * identifiers; those never leave the server. Only what an ambiguous timeout
 * reconciliation needs is published: identity, canonical event and timestamps.
 */
export interface FeedbackReceiptStatus {
  response_id: string
  kind: 'feedback' | 'survey'
  event: 'survey_completed' | 'feedback_submitted'
  event_id: string | null
  received_at: string
  score: number | null
}
