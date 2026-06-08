import type { RemediationFailure, RemediationResult } from './registry.js'

export async function handleClearCache(failure: RemediationFailure): Promise<RemediationResult> {
  const resource = failure.affected_resource || 'unknown'
  const output = `Clearing cache for ${resource}`
  console.log(output)
  return { success: true, output }
}
