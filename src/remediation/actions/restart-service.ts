import type { RemediationFailure, RemediationResult } from './registry.js'

export async function handleRestartService(failure: RemediationFailure): Promise<RemediationResult> {
  const resource = failure.affected_resource || 'unknown'
  const output = `Would restart service for ${resource}`
  console.log(output)
  return {
    success: true,
    output,
    rollback: async () => {
      console.log(`Rollback: would abort restart for ${resource}`)
    },
  }
}
