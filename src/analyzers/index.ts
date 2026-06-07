export { parseConventionalCommit, parseChangelog, classifyBreakingReason, extractBreakingChangesFromCommits } from './changelog-parser.js'
export type { ChangelogEntry, ParsedCommit } from './changelog-parser.js'

export { parseSemver, compareSemver, isBreakingChange, versionToString } from './semver.js'
export type { SemverVersion, SemverDiff } from './semver.js'

export { classifyChange } from './severity-classifier.js'
export type { ChangeSeverity, ClassifiedChange, ClassificationOptions } from './severity-classifier.js'

export {
  classifyWebhookFailure,
  classifyTokenFailure,
  classifyRateLimitFailure,
  classifySchemaDrift,
  classifyMonitorDowntime,
  classifySslExpiry,
  classifySlowResponse,
  classifySentrySpike,
  classifySentryNewPattern,
} from './failure-classifier.js'
export type {
  FailureType,
  ClassifiedFailure,
  WebhookFailureInput,
  TokenFailureInput,
  RateLimitFailureInput,
  SchemaDriftInput,
  MonitorDowntimeInput,
  MonitorSslInput,
  MonitorSlowResponseInput,
  SentrySpikeInput,
  SentryNewPatternInput,
} from './failure-classifier.js'