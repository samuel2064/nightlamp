export { evaluateAndNotify } from './evaluator';
export { sendNotification } from './channels';
export type {
  ChannelType,
  SlackConfig,
  EmailConfig,
  PagerDutyConfig,
  ChannelConfig,
  NotificationPayload,
} from './channels';
export type {
  AlertChannel,
  AlertRule,
  AlertLogEntry,
} from './evaluator';
