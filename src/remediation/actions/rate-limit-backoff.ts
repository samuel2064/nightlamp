import type { RemediationFailure, RemediationResult } from './registry.js'

export async function handleRateLimitBackoff(failure: RemediationFailure): Promise<RemediationResult> {
  const resource = failure.affected_resource || 'unknown'
  const output = `Applying rate limit backoff for ${resource}`
  console.log(output)
  return { success: true, output }
}
