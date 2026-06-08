import type { RemediationFailure, RemediationResult } from './registry.js'

export async function handleRetryWebhook(failure: RemediationFailure): Promise<RemediationResult> {
  const resource = failure.affected_resource || 'unknown'
  const output = `Retrying webhook for ${resource}`
  console.log(output)
  return { success: true, output }
}
