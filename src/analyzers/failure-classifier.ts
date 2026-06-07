import type { ChangeSeverity } from './severity-classifier.js'

export type FailureType =
  | 'integration.webhook.failed'
  | 'integration.token.expired'
  | 'integration.rate-limit'
  | 'schema.drift'
  | 'monitor.downtime'
  | 'monitor.ssl-expiring'
  | 'monitor.slow-response'
  | 'sentry.error-spike'
  | 'sentry.new-pattern'

export interface ClassifiedFailure {
  failureType: FailureType
  resource: string
  severity: ChangeSeverity
  title: string
  description: string
  diagnosis: string
  remediation: string
  details: Record<string, string>
}

export interface WebhookFailureInput {
  url: string
  statusCode?: number
  responseTimeMs?: number
  error?: string
  retryAttempts?: number
}

export interface TokenFailureInput {
  service: string
  expiredAt?: string
  daysSinceExpiry?: number
  isProduction?: boolean
}

export interface RateLimitFailureInput {
  service: string
  limit: number
  remaining: number
  resetAt?: string
  recentTrend?: 'increasing' | 'stable' | 'decreasing'
}

export interface SchemaDriftInput {
  service: string
  expectedSchema: string
  receivedSchema: string
  changedFields: string[]
  changeType: 'field_removed' | 'field_added' | 'field_type_changed' | 'field_required' | 'multiple'
}

export interface MonitorDowntimeInput {
  monitorName: string
  monitorUrl: string
  durationMinutes: number
  currentStatus: string
  uptimeRatio: number
}

export interface MonitorSslInput {
  monitorName: string
  monitorUrl: string
  sslStatus: string
  daysRemaining: number
}

export interface MonitorSlowResponseInput {
  monitorName: string
  monitorUrl: string
  responseTimeMs: number
  thresholdMs: number
}

export interface SentrySpikeInput {
  project: string
  currentVolume: number
  baselineVolume: number
  multiplier: number
  topErrors: Array<{ title: string; count: number }>
}

export interface SentryNewPatternInput {
  project: string
  errorTitle: string
  errorLevel: string
  firstSeen: string
  errorCount: number
}

export function classifyWebhookFailure(input: WebhookFailureInput): ClassifiedFailure {
  const statusCode = input.statusCode
  const responseTime = input.responseTimeMs || 0
  const retries = input.retryAttempts || 0
  const hasError = !!input.error

  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (statusCode !== undefined && statusCode >= 500) {
    severity = 'critical'
    diagnosis = 'Endpoint returned server error. Check if the service is down or the URL is misconfigured. Verify DNS resolution and network connectivity.'
    remediation = 'Verify endpoint availability. Check server logs for errors. Ensure URL is correct and the service is running. Implement retry with exponential backoff.'
  } else if (statusCode !== undefined && statusCode >= 400) {
    severity = 'high'
    diagnosis = 'Client error returned by endpoint. Check if request payload format matches what the endpoint expects. Verify authentication headers.'
    remediation = 'Review webhook payload format. Verify authentication credentials. Check endpoint documentation for API changes.'
  } else if (hasError && statusCode === undefined) {
    severity = 'high'
    diagnosis = 'Webhook delivery failed with error. Endpoint may be unreachable or rejecting connections.'
    remediation = 'Verify endpoint URL and network connectivity. Check if the endpoint service is running and accepting connections.'
  } else if (responseTime > 10000) {
    severity = 'medium'
    diagnosis = 'Webhook delivery is slow, exceeding 10 seconds. May indicate endpoint performance degradation.'
    remediation = 'Investigate endpoint performance. Consider asynchronous processing if the endpoint is slow.'
  } else if (retries > 3) {
    severity = 'medium'
    diagnosis = 'Webhook delivery required multiple retry attempts, indicating intermittent availability issues.'
    remediation = 'Review endpoint availability history. Consider implementing circuit breaker pattern.'
  } else {
    severity = 'low'
    diagnosis = 'Minor webhook delivery anomaly detected.'
    remediation = 'Monitor for recurring patterns. No immediate action required.'
  }

  const description = [
    `Webhook to ${input.url} failed`,
    statusCode ? `with status ${statusCode}` : '',
    responseTime ? `(response time: ${responseTime}ms)` : '',
    retries ? `after ${retries} retries` : '',
    input.error ? `. Error: ${input.error}` : '',
  ].filter(Boolean).join(' ')

  return {
    failureType: 'integration.webhook.failed',
    resource: input.url,
    severity,
    title: `Webhook delivery failed: ${input.url}`,
    description,
    diagnosis,
    remediation,
    details: {
      url: input.url,
      statusCode: String(statusCode),
      responseTimeMs: String(responseTime),
      retryAttempts: String(retries),
      error: input.error || '',
    },
  }
}

export function classifyTokenFailure(input: TokenFailureInput): ClassifiedFailure {
  const daysSinceExpiry = input.daysSinceExpiry ?? (
    input.expiredAt ? Math.floor((Date.now() - new Date(input.expiredAt).getTime()) / 86400000) : 0
  )

  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (input.isProduction && daysSinceExpiry > 0) {
    severity = 'critical'
    diagnosis = 'Production authentication token has expired. All service-to-service communication using this token will fail.'
    remediation = 'Generate a new production token immediately. Update the secret store. Verify all services pick up the new token. Post-incident review of token rotation procedures.'
  } else if (daysSinceExpiry > 0) {
    severity = 'high'
    diagnosis = 'Authentication token has expired. Non-production environments may experience integration failures.'
    remediation = 'Generate a new token from the issuer. Update the credential store. Verify token works with a test request.'
  } else {
    severity = 'medium'
    diagnosis = 'Authentication token will expire soon. Schedule renewal before expiry to avoid service disruption.'
    remediation = 'Generate a new token. Update credential store before current token expires. Set up automated rotation if available.'
  }

  return {
    failureType: 'integration.token.expired',
    resource: input.service,
    severity,
    title: `Authentication token expired: ${input.service}`,
    description: `Token for ${input.service} expired ${daysSinceExpiry > 0 ? `${daysSinceExpiry} days ago` : 'soon'}.${input.isProduction ? ' [PRODUCTION]' : ''}`,
    diagnosis,
    remediation,
    details: {
      service: input.service,
      expiredAt: input.expiredAt || 'unknown',
      daysSinceExpiry: String(daysSinceExpiry),
      isProduction: String(input.isProduction || false),
    },
  }
}

export function classifyRateLimitFailure(input: RateLimitFailureInput): ClassifiedFailure {
  const usagePercent = input.limit > 0 ? Math.round(((input.limit - input.remaining) / input.limit) * 100) : 0

  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (usagePercent >= 95) {
    severity = 'critical'
    diagnosis = 'API rate limit nearly exhausted. Requests will be rejected imminently. Check if a recent code change or deploy increased call frequency.'
    remediation = 'Reduce polling frequency immediately. Implement request queuing. Request rate limit increase from provider. Investigate root cause of increased usage.'
  } else if (usagePercent >= 80) {
    severity = 'high'
    diagnosis = 'API rate limit usage is critically high. Risk of hitting the limit during traffic spikes.'
    remediation = 'Review call patterns and optimize. Implement client-side caching where possible. Consider requesting a rate limit increase.'
  } else if (input.recentTrend === 'increasing') {
    severity = 'medium'
    diagnosis = 'API rate limit usage is trending upward. May reach critical levels if trend continues.'
    remediation = 'Monitor usage trend over the next week. Review if new features are increasing API call volume. Plan for optimization or limit increase.'
  } else {
    severity = 'low'
    diagnosis = 'API rate limit usage is within normal parameters.'
    remediation = 'Continue monitoring. No immediate action required.'
  }

  return {
    failureType: 'integration.rate-limit',
    resource: input.service,
    severity,
    title: `Rate limit ${severity === 'critical' ? 'nearly exhausted' : 'usage high'}: ${input.service}`,
    description: `API rate limit for ${input.service}: ${usagePercent}% used (${input.remaining}/${input.limit} remaining).${input.resetAt ? ` Resets at ${input.resetAt}.` : ''}`,
    diagnosis,
    remediation,
    details: {
      service: input.service,
      limit: String(input.limit),
      remaining: String(input.remaining),
      usagePercent: String(usagePercent),
      resetAt: input.resetAt || '',
      recentTrend: input.recentTrend || 'stable',
    },
  }
}

export function classifySchemaDrift(input: SchemaDriftInput): ClassifiedFailure {
  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (input.changeType === 'field_removed') {
    severity = 'critical'
    diagnosis = 'Required fields have been removed from the API response. This will cause deserialization errors in consuming code.'
    remediation = 'Update consuming code to handle the removed field. Add fallback defaults. Notify team about the schema change. Update API client type definitions.'
  } else if (input.changeType === 'field_required') {
    severity = 'high'
    diagnosis = 'Previously optional fields are now required. Existing requests may fail if they omit these fields.'
    remediation = 'Update all request payloads to include the newly required fields. Review API documentation for the change rationale.'
  } else if (input.changeType === 'field_type_changed') {
    severity = 'high'
    diagnosis = `Field types have changed: ${input.changedFields.join(', ')}. This may cause type errors in consuming code.`
    remediation = 'Update type definitions to match the new schema. Add runtime validation for field types. Test all code paths that consume these fields.'
  } else if (input.changeType === 'field_added') {
    severity = 'low'
    diagnosis = 'New fields have been added to the API response. No immediate breakage expected, but review for relevance.'
    remediation = 'Review new fields and update type definitions. Consider adding new fields to consuming code if beneficial.'
  } else {
    severity = 'medium'
    diagnosis = `Multiple schema changes detected: ${input.changedFields.join(', ')}. Review each change for impact.`
    remediation = 'Compare expected vs received schema systematically. Update all consuming code and tests. Add schema validation middleware.'
  }

  return {
    failureType: 'schema.drift',
    resource: input.service,
    severity,
    title: `Schema drift detected: ${input.service}`,
    description: `Schema for ${input.service} has changed. Expected: ${input.expectedSchema}, Received: ${input.receivedSchema}. Changed fields: ${input.changedFields.join(', ')}.`,
    diagnosis,
    remediation,
    details: {
      service: input.service,
      expectedSchema: input.expectedSchema,
      receivedSchema: input.receivedSchema,
      changedFields: input.changedFields.join(', '),
      changeType: input.changeType,
    },
  }
}

export function classifyMonitorDowntime(input: MonitorDowntimeInput): ClassifiedFailure {
  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (input.durationMinutes > 60 || input.uptimeRatio < 95) {
    severity = 'critical'
    diagnosis = 'Extended downtime detected with significant impact on availability SLO. Investigate root cause immediately.'
    remediation = 'Check server logs and infrastructure metrics. Identify root cause (deploy failure, resource exhaustion, network issue). Roll back recent changes if applicable. Notify stakeholders.'
  } else if (input.durationMinutes > 15) {
    severity = 'high'
    diagnosis = 'Moderate downtime duration. Service is degraded and requires investigation.'
    remediation = 'Check service health endpoints and recent deploy history. Review error rate dashboards. Restart service if unresponsive.'
  } else {
    severity = 'medium'
    diagnosis = 'Brief downtime detected. May be transient or due to deployment restart.'
    remediation = 'Verify service recovered automatically. Check deploy logs for recent changes. Monitor for recurrence.'
  }

  return {
    failureType: 'monitor.downtime',
    resource: input.monitorName,
    severity,
    title: `Monitor down: ${input.monitorName}`,
    description: `${input.monitorName} (${input.monitorUrl}) has been ${input.currentStatus} for ${input.durationMinutes} minutes. Current uptime: ${input.uptimeRatio}%.`,
    diagnosis,
    remediation,
    details: {
      monitorName: input.monitorName,
      monitorUrl: input.monitorUrl,
      durationMinutes: String(input.durationMinutes),
      currentStatus: input.currentStatus,
      uptimeRatio: String(input.uptimeRatio),
    },
  }
}

export function classifySslExpiry(input: MonitorSslInput): ClassifiedFailure {
  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (input.daysRemaining <= 0 || input.sslStatus === 'expired') {
    severity = 'critical'
    diagnosis = 'SSL certificate has expired. Users will see security warnings and the service will be unreachable over HTTPS.'
    remediation = 'Renew SSL certificate immediately. Install the new certificate on the server. Verify HTTPS is working after renewal. Set up automated renewal reminders.'
  } else if (input.daysRemaining <= 7) {
    severity = 'high'
    diagnosis = `SSL certificate expires in ${input.daysRemaining} day(s). Renewal is urgent to prevent service disruption.`
    remediation = 'Request certificate renewal now. Follow certificate issuance process. Schedule installation before expiry date.'
  } else if (input.daysRemaining <= 30) {
    severity = 'medium'
    diagnosis = `SSL certificate expires in ${input.daysRemaining} day(s). Schedule renewal before the deadline.`
    remediation = 'Plan certificate renewal. Verify DNS records for domain validation. Ensure certificate management contacts are up to date.'
  } else {
    severity = 'low'
    diagnosis = 'SSL certificate is valid. No immediate action required.'
    remediation = 'Continue monitoring SSL expiry. Consider setting up automated renewal with Let\'s Encrypt or similar.'
  }

  return {
    failureType: 'monitor.ssl-expiring',
    resource: input.monitorName,
    severity,
    title: `SSL certificate ${input.sslStatus === 'expired' ? 'expired' : 'expiring soon'}: ${input.monitorName}`,
    description: `SSL certificate for ${input.monitorName} (${input.monitorUrl}) status: ${input.sslStatus}. ${input.daysRemaining > 0 ? `${input.daysRemaining} day(s) remaining.` : 'EXPIRED.'}`,
    diagnosis,
    remediation,
    details: {
      monitorName: input.monitorName,
      monitorUrl: input.monitorUrl,
      sslStatus: input.sslStatus,
      daysRemaining: String(input.daysRemaining),
    },
  }
}

export function classifySlowResponse(input: MonitorSlowResponseInput): ClassifiedFailure {
  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (input.responseTimeMs > input.thresholdMs * 3) {
    severity = 'high'
    diagnosis = 'Response time is critically slow (3x+ threshold). Service performance is severely degraded.'
    remediation = 'Investigate server resource utilization (CPU, memory, database). Check for slow database queries. Consider scaling up resources or optimizing code.'
  } else if (input.responseTimeMs > input.thresholdMs * 1.5) {
    severity = 'medium'
    diagnosis = 'Response time is significantly above threshold. Performance degradation may affect user experience.'
    remediation = 'Profile application performance. Check for memory leaks, database connection pool exhaustion, or increased traffic. Consider horizontal scaling.'
  } else {
    severity = 'low'
    diagnosis = 'Response time is slightly above threshold. Minor performance variance.'
    remediation = 'Monitor response time trends. Investigate if this correlates with traffic patterns or deploy events.'
  }

  return {
    failureType: 'monitor.slow-response',
    resource: input.monitorName,
    severity,
    title: `Slow response time: ${input.monitorName}`,
    description: `${input.monitorName} (${input.monitorUrl}) responded in ${input.responseTimeMs}ms (threshold: ${input.thresholdMs}ms).`,
    diagnosis,
    remediation,
    details: {
      monitorName: input.monitorName,
      monitorUrl: input.monitorUrl,
      responseTimeMs: String(input.responseTimeMs),
      thresholdMs: String(input.thresholdMs),
    },
  }
}

export function classifySentrySpike(input: SentrySpikeInput): ClassifiedFailure {
  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  const topErrorTitles = input.topErrors.slice(0, 3).map((e) => `${e.title} (x${e.count})`).join('; ')

  if (input.multiplier >= 10) {
    severity = 'critical'
    diagnosis = `Massive error spike detected: ${input.multiplier}x baseline. Service may be in a broken state. Check recent deploy and roll back if necessary.`
    remediation = 'Immediately investigate recent code changes. Check deploy events correlated with spike start. Roll back if recent deploy is the cause. Notify on-call engineer.'
  } else if (input.multiplier >= 5) {
    severity = 'high'
    diagnosis = `Significant error spike: ${input.multiplier}x baseline. Top errors: ${topErrorTitles}.`
    remediation = 'Investigate top error sources. Review recent code changes. Add monitoring and alerting for the affected error patterns.'
  } else {
    severity = 'medium'
    diagnosis = `Moderate error spike: ${input.multiplier}x baseline. Errors may indicate emerging issues.`
    remediation = 'Review error patterns in Sentry. Correlate with recent changes or deployments. Add targeted monitoring if pattern persists.'
  }

  return {
    failureType: 'sentry.error-spike',
    resource: input.project,
    severity,
    title: `Error spike detected: ${input.project}`,
    description: `Sentry project ${input.project} error volume spike: ${input.currentVolume} events (${input.multiplier}x baseline of ${input.baselineVolume}). Top errors: ${topErrorTitles}`,
    diagnosis,
    remediation,
    details: {
      project: input.project,
      currentVolume: String(input.currentVolume),
      baselineVolume: String(input.baselineVolume),
      multiplier: String(input.multiplier),
      topErrors: topErrorTitles,
    },
  }
}

export function classifySentryNewPattern(input: SentryNewPatternInput): ClassifiedFailure {
  let severity: ChangeSeverity
  let diagnosis: string
  let remediation: string

  if (input.errorLevel === 'fatal') {
    severity = 'critical'
    diagnosis = 'New fatal error pattern detected. This may indicate a critical bug or security issue affecting users.'
    remediation = 'Investigate immediately. Check stack trace and correlated log lines. Determine if this is a regression from a recent change. File a bug and assign for triage.'
  } else if (input.errorCount >= 100 || input.errorLevel === 'error') {
    severity = 'high'
    diagnosis = `New error pattern detected: "${input.errorTitle}". First seen ${input.firstSeen}. Occurred ${input.errorCount} times.`
    remediation = 'Review error details in Sentry. Add stack trace to investigation. Determine if this is a new bug or expected behavior. Create a fix if necessary.'
  } else {
    severity = 'medium'
    diagnosis = `New error pattern detected with low frequency: "${input.errorTitle}". First seen ${input.firstSeen}.`
    remediation = 'Monitor error frequency over the next 24 hours. Investigate if the error correlates with specific user actions or environments.'
  }

  return {
    failureType: 'sentry.new-pattern',
    resource: input.project,
    severity,
    title: `New error pattern: ${input.errorTitle}`,
    description: `New Sentry error pattern in ${input.project}: "${input.errorTitle}" (level: ${input.errorLevel}). First seen: ${input.firstSeen}. Total occurrences: ${input.errorCount}.`,
    diagnosis,
    remediation,
    details: {
      project: input.project,
      errorTitle: input.errorTitle,
      errorLevel: input.errorLevel,
      firstSeen: input.firstSeen,
      errorCount: String(input.errorCount),
    },
  }
}
