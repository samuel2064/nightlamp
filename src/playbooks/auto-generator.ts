import { createPlaybookEntry } from './playbook.js'
import type { CreatePlaybookEntry } from './playbook.js'

const playbookTemplates: Record<string, (resource: string, details: Record<string, string>) => CreatePlaybookEntry> = {
  'dependency.breaking': (resource, details) => ({
    failureType: 'dependency.breaking',
    source: 'npm-registry',
    severity: details.severity === 'critical' ? 'critical' : 'high',
    title: `Breaking dependency change: ${resource}`,
    description: `Dependency ${resource} changed from ${details.fromVersion || 'unknown'} to ${details.toVersion || 'unknown'}. Reason: ${details.reason || 'Semver major bump detected.'}`,
    affectedResource: resource,
    diagnosis: 'Check semver diff and changelog for breaking API changes. Verify all consuming code paths for compatibility.',
    remediation: 'Review changelog entries. Update consuming code to use new APIs. Run full test suite. Pin to previous version if migration is blocked.',
    relatedEntries: `dependency:${resource}`,
  }),

  'dependency.outdated': (resource, details) => ({
    failureType: 'dependency.outdated',
    source: 'npm-registry',
    severity: 'medium',
    title: `Outdated dependency: ${resource}`,
    description: `Dependency ${resource} is ${details.versionsBehind || 'multiple'} version(s) behind latest (${details.toVersion || 'latest'}). Current: ${details.fromVersion || 'unknown'}.`,
    affectedResource: resource,
    diagnosis: 'Review changelog between current and latest version for breaking changes or security patches.',
    remediation: 'Update to latest compatible version. Run tests to verify compatibility. Consider automating with Dependabot or Renovate.',
    relatedEntries: `dependency:${resource}`,
  }),

  'integration.webhook.failed': (resource, details) => ({
    failureType: 'integration.webhook.failed',
    source: 'webhook',
    severity: 'high',
    title: `Webhook delivery failed: ${resource}`,
    description: `Webhook to ${resource} failed with status ${details.status || 'unknown'}. Error: ${details.error || 'No response from endpoint.'}`,
    affectedResource: resource,
    diagnosis: 'Check endpoint availability and response time. Verify webhook secret and payload format.',
    remediation: 'Verify endpoint URL and authentication. Check endpoint logs for errors. Retry delivery with exponential backoff.',
    relatedEntries: `integration:${resource}`,
  }),

  'integration.token.expired': (resource, details) => ({
    failureType: 'integration.token.expired',
    source: 'token-manager',
    severity: 'critical',
    title: `Authentication token expired: ${resource}`,
    description: `Token for ${resource} expired at ${details.expiredAt || 'unknown'}. Service integration will be degraded until renewed.`,
    affectedResource: resource,
    diagnosis: 'Check token expiry date and rotation policy. Verify token issuer is reachable.',
    remediation: 'Generate new token from issuer. Update secret store. Verify new token works by sending test request. Set up rotation reminder.',
    relatedEntries: `integration:${resource}`,
  }),

  'integration.rate-limit': (resource, details) => ({
    failureType: 'integration.rate-limit',
    source: 'api-gateway',
    severity: 'medium',
    title: `Rate limit exceeded: ${resource}`,
    description: `API rate limit for ${resource} exceeded. Limit: ${details.limit || 'unknown'}, Reset at: ${details.resetAt || 'unknown'}.`,
    affectedResource: resource,
    diagnosis: 'Monitor request volume to the API. Check if a recent deploy changed call frequency.',
    remediation: 'Reduce polling frequency. Implement backoff strategy. Request rate limit increase from provider if needed.',
    relatedEntries: `integration:${resource}`,
  }),

  'schema.drift': (resource, details) => ({
    failureType: 'schema.drift',
    source: 'schema-registry',
    severity: 'high',
    title: `Schema drift detected: ${resource}`,
    description: `Schema for ${resource} has changed. Expected: ${details.expectedField || 'original schema'}, Received: ${details.receivedField || 'unknown field'}.`,
    affectedResource: resource,
    diagnosis: 'Compare expected vs received schema. Identify new, removed, or changed fields. Check if integration partner pushed a schema update.',
    remediation: 'Update consuming code to handle new schema. Add field-level fallback defaults. Notify team about schema change. Update tests.',
    relatedEntries: `schema:${resource}`,
  }),
}

export function generatePlaybookEntry(
  failureType: string,
  resource: string,
  details: Record<string, string> = {},
): ReturnType<typeof createPlaybookEntry> {
  const template = playbookTemplates[failureType]
  if (template) {
    return createPlaybookEntry(template(resource, details))
  }

  return createPlaybookEntry({
    failureType,
    source: 'unknown',
    severity: 'medium',
    title: `Failure detected: ${failureType} on ${resource}`,
    description: details.message || `An unclassified failure of type "${failureType}" was detected on resource "${resource}".`,
    affectedResource: resource,
    diagnosis: 'No predefined diagnostic steps for this failure type. Investigate logs and metrics.',
    remediation: 'Determine root cause and document remediation steps. Consider adding a playbook template for this failure type.',
    relatedEntries: undefined,
  })
}

export function registerPlaybookTemplate(
  failureType: string,
  generator: (resource: string, details: Record<string, string>) => CreatePlaybookEntry,
): void {
  playbookTemplates[failureType] = generator
}

export function getRegisteredFailureTypes(): string[] {
  return Object.keys(playbookTemplates)
}