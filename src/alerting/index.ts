export { sendSlackAlert, buildBreakingChangeAlert, buildHealthSummaryAlert } from './slack.js'
export type { SlackConfig, SlackMessage, SlackAttachment } from './slack.js'

export { sendWebhook, buildDependencyChangePayload, buildHealthCheckPayload } from './webhook.js'
export type { WebhookConfig, WebhookPayload, WebhookResult } from './webhook.js'

export { evaluatePreShipGate, formatPrComment } from './pre-ship-gate.js'
export type { PrCommentInput, PrCheckResult } from './pre-ship-gate.js'