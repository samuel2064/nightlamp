import { createPlaybookEntry, getPlaybooksBySource } from './playbook.js'
import { registerPlaybookTemplate } from './auto-generator.js'
import type { ClassifiedFailure } from '../analyzers/failure-classifier.js'

export interface KnownFailurePattern {
  failureType: string
  resource: string
  firstDetectedAt: string
  lastDetectedAt: string
  occurrenceCount: number
}

export interface FailureWriterConfig {
  autoResolveAfterMinutes?: number
}

const knownPatterns = new Map<string, KnownFailurePattern>()

export function getPatternKey(failureType: string, resource: string): string {
  return `${failureType}::${resource}`
}

export function getKnownPatterns(): KnownFailurePattern[] {
  return Array.from(knownPatterns.values())
}

export function isKnownPattern(failureType: string, resource: string): boolean {
  return knownPatterns.has(getPatternKey(failureType, resource))
}

export function getKnownPattern(failureType: string, resource: string): KnownFailurePattern | undefined {
  return knownPatterns.get(getPatternKey(failureType, resource))
}

function upsertKnownPattern(failureType: string, resource: string): KnownFailurePattern {
  const key = getPatternKey(failureType, resource)
  const now = new Date().toISOString()
  const existing = knownPatterns.get(key)

  if (existing) {
    existing.lastDetectedAt = now
    existing.occurrenceCount++
    return existing
  }

  const pattern: KnownFailurePattern = {
    failureType,
    resource,
    firstDetectedAt: now,
    lastDetectedAt: now,
    occurrenceCount: 1,
  }
  knownPatterns.set(key, pattern)
  return pattern
}

function registerFailureTemplates(): void {
  registerPlaybookTemplate('monitor.downtime', (resource, details) => ({
    failureType: 'monitor.downtime',
    source: 'uptime-robot',
    severity: (details.severity as 'critical' | 'high' | 'medium' | 'low') || 'high',
    title: `Monitor down: ${resource}`,
    description: details.description || `Monitor ${resource} has been down. Duration: ${details.durationMinutes || 'unknown'} minutes.`,
    affectedResource: resource,
    diagnosis: 'Check server logs and infrastructure metrics. Verify the service is running and reachable. Review recent deploy history.',
    remediation: 'Restart the service if down. Roll back recent changes if correlated. Notify stakeholders if extended downtime.',
    relatedEntries: `monitor:${resource}`,
  }))

  registerPlaybookTemplate('monitor.ssl-expiring', (resource, details) => ({
    failureType: 'monitor.ssl-expiring',
    source: 'uptime-robot',
    severity: (details.severity as 'critical' | 'high' | 'medium' | 'low') || 'high',
    title: `SSL certificate ${details.sslStatus === 'expired' ? 'expired' : 'expiring soon'}: ${resource}`,
    description: details.description || `SSL certificate for ${resource} status: ${details.sslStatus || 'unknown'}. ${details.daysRemaining ? `${details.daysRemaining} day(s) remaining.` : ''}`,
    affectedResource: resource,
    diagnosis: 'Check SSL certificate expiry date. Verify certificate issuer is reachable for renewal.',
    remediation: 'Renew SSL certificate immediately if expired. Schedule renewal before expiry if still valid. Install updated certificate.',
    relatedEntries: `monitor:${resource}`,
  }))

  registerPlaybookTemplate('monitor.slow-response', (resource, details) => ({
    failureType: 'monitor.slow-response',
    source: 'uptime-robot',
    severity: (details.severity as 'critical' | 'high' | 'medium' | 'low') || 'medium',
    title: `Slow response time: ${resource}`,
    description: details.description || `${resource} responded in ${details.responseTimeMs || 'unknown'}ms (threshold: ${details.thresholdMs || '5000'}ms).`,
    affectedResource: resource,
    diagnosis: 'Profile application performance. Check resource utilization (CPU, memory, database). Look for slow queries or memory leaks.',
    remediation: 'Scale up resources if needed. Optimize slow database queries. Add caching for frequently accessed data.',
    relatedEntries: `monitor:${resource}`,
  }))

  registerPlaybookTemplate('sentry.error-spike', (resource, details) => ({
    failureType: 'sentry.error-spike',
    source: 'sentry',
    severity: (details.severity as 'critical' | 'high' | 'medium' | 'low') || 'high',
    title: `Error spike detected: ${resource}`,
    description: details.description || `Sentry project ${resource} error volume spike detected. Multiplier: ${details.multiplier || 'unknown'}x.`,
    affectedResource: resource,
    diagnosis: 'Review Sentry dashboard for error distribution. Check for correlated deploy events. Analyze stack traces of top errors.',
    remediation: 'Roll back recent deploy if correlated. Fix top error patterns. Add monitoring for affected endpoints.',
    relatedEntries: `sentry:${resource}`,
  }))

  registerPlaybookTemplate('sentry.new-pattern', (resource, details) => ({
    failureType: 'sentry.new-pattern',
    source: 'sentry',
    severity: (details.severity as 'critical' | 'high' | 'medium' | 'low') || 'medium',
    title: `New error pattern: ${details.errorTitle || resource}`,
    description: details.description || `New error pattern detected in ${resource}: "${details.errorTitle || 'unknown'}".`,
    affectedResource: resource,
    diagnosis: 'Review stack trace and log context. Determine if this is a new bug or expected behavior change.',
    remediation: 'File a bug and assign for triage. Add targeted monitoring. Fix and deploy if it causes user-facing issues.',
    relatedEntries: `sentry:${resource}`,
  }))
}

registerFailureTemplates()

function classifyToPlaybookInput(
  classification: ClassifiedFailure,
): {
  failureType: string
  source: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  description: string
  affectedResource: string
  diagnosis: string
  remediation: string
  relatedEntries?: string
} {
  const sourceMap: Record<string, string> = {
    'integration.webhook.failed': 'webhook',
    'integration.token.expired': 'token-manager',
    'integration.rate-limit': 'api-gateway',
    'schema.drift': 'schema-registry',
    'monitor.downtime': 'uptime-robot',
    'monitor.ssl-expiring': 'uptime-robot',
    'monitor.slow-response': 'uptime-robot',
    'sentry.error-spike': 'sentry',
    'sentry.new-pattern': 'sentry',
  }

  const relatedMap: Record<string, string> = {
    'integration.webhook.failed': `integration:${classification.resource}`,
    'integration.token.expired': `integration:${classification.resource}`,
    'integration.rate-limit': `integration:${classification.resource}`,
    'schema.drift': `schema:${classification.resource}`,
    'monitor.downtime': `monitor:${classification.resource}`,
    'monitor.ssl-expiring': `monitor:${classification.resource}`,
    'monitor.slow-response': `monitor:${classification.resource}`,
    'sentry.error-spike': `sentry:${classification.resource}`,
    'sentry.new-pattern': `sentry:${classification.resource}`,
  }

  return {
    failureType: classification.failureType,
    source: sourceMap[classification.failureType] || 'unknown',
    severity: classification.severity as 'critical' | 'high' | 'medium' | 'low',
    title: classification.title,
    description: classification.description,
    affectedResource: classification.resource,
    diagnosis: classification.diagnosis,
    remediation: classification.remediation,
    relatedEntries: relatedMap[classification.failureType],
  }
}

export function writeFailureToPlaybook(classification: ClassifiedFailure): {
  entry: ReturnType<typeof createPlaybookEntry>
  isNew: boolean
} {
  const pattern = upsertKnownPattern(classification.failureType, classification.resource)
  const isNew = pattern.occurrenceCount === 1

  const playbookInput = classifyToPlaybookInput(classification)
  const entry = createPlaybookEntry(playbookInput)

  return { entry, isNew }
}

export function writeFailuresToPlaybook(classifications: ClassifiedFailure[]): Array<{
  entry: ReturnType<typeof createPlaybookEntry>
  isNew: boolean
  failureType: string
  resource: string
}> {
  return classifications.map((c) => ({
    ...writeFailureToPlaybook(c),
    failureType: c.failureType,
    resource: c.resource,
  }))
}

export function resetKnownPatterns(): void {
  knownPatterns.clear()
}

export function getFailureReport(options?: {
  source?: string
  severity?: string
  limit?: number
}): Array<{
  pattern: KnownFailurePattern
  playbookEntry: ReturnType<typeof createPlaybookEntry> | undefined
}> {
  const entries = getPlaybooksBySource(options?.source || '')
    .filter((e) => !options?.severity || e.severity === options.severity)
    .slice(0, options?.limit || 50)
    .map((entry) => ({
      pattern: {
        failureType: entry.failureType,
        resource: entry.affectedResource,
        firstDetectedAt: entry.firstDetectedAt,
        lastDetectedAt: entry.lastDetectedAt,
        occurrenceCount: entry.occurrenceCount,
      },
      playbookEntry: entry,
    }))

  return entries
}

export async function pollAndWriteSentryFailures(
  config: { org: string; project: string; authToken: string },
  options?: { statsPeriod?: string },
): Promise<Array<{ entry: ReturnType<typeof createPlaybookEntry>; isNew: boolean; failureType: string; resource: string }>> {
  const { pollSentryErrors, detectErrorSpike, detectNewErrorPatterns } = await import('../connectors/sentry.js')
  const { classifySentrySpike, classifySentryNewPattern } = await import('../analyzers/failure-classifier.js')

  const errors = await pollSentryErrors(config, { statsPeriod: options?.statsPeriod })

  const classifications: ClassifiedFailure[] = []
  const spike = detectErrorSpike(errors, 10)
  if (spike) {
    classifications.push(classifySentrySpike({
      project: config.project,
      currentVolume: spike.currentVolume,
      baselineVolume: spike.baselineVolume,
      multiplier: spike.multiplier,
      topErrors: spike.errors.map((e) => ({ title: e.title, count: e.count })),
    }))
  }

  const knownIds = new Set<string>()
  for (const pattern of knownPatterns.values()) {
    if (pattern.failureType === 'sentry.new-pattern') {
      knownIds.add(pattern.resource)
    }
  }
  const newPatterns = detectNewErrorPatterns(errors, knownIds)
  for (const np of newPatterns) {
    classifications.push(classifySentryNewPattern({
      project: config.project,
      errorTitle: np.error.title,
      errorLevel: np.error.level,
      firstSeen: np.firstSeen,
      errorCount: np.error.count,
    }))
  }

  return writeFailuresToPlaybook(classifications)
}

export async function pollAndWriteUptimeRobotFailures(
  config: { apiKey: string },
): Promise<Array<{ entry: ReturnType<typeof createPlaybookEntry>; isNew: boolean; failureType: string; resource: string }>> {
  const { pollUptimeRobotMonitors } = await import('../connectors/uptime-robot.js')
  const { classifyMonitorDowntime, classifySslExpiry, classifySlowResponse } = await import('../analyzers/failure-classifier.js')

  const result = await pollUptimeRobotMonitors(config)

  const classifications: ClassifiedFailure[] = []

  for (const monitor of result.downMonitors) {
    classifications.push(classifyMonitorDowntime({
      monitorName: monitor.friendlyName,
      monitorUrl: monitor.url,
      durationMinutes: 5,
      currentStatus: monitor.statusLabel,
      uptimeRatio: monitor.uptimeRatio,
    }))
  }

  for (const monitor of result.sslIssues) {
    classifications.push(classifySslExpiry({
      monitorName: monitor.friendlyName,
      monitorUrl: monitor.url,
      sslStatus: monitor.ssl.status,
      daysRemaining: monitor.ssl.daysRemaining ?? 0,
    }))
  }

  for (const monitor of result.slowMonitors) {
    classifications.push(classifySlowResponse({
      monitorName: monitor.friendlyName,
      monitorUrl: monitor.url,
      responseTimeMs: monitor.responseTime,
      thresholdMs: 5000,
    }))
  }

  return writeFailuresToPlaybook(classifications)
}
