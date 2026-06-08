import type { RemediationFailure, RemediationResult } from './registry.js'

export async function handleNpmUpdate(failure: RemediationFailure): Promise<RemediationResult> {
  const resource = failure.affected_resource || 'unknown'
  const output = `Would run: npm update ${resource} for ${failure.affected_resource}`
  console.log(output)
  return {
    success: true,
    output,
    rollback: async () => {
      console.log(`Rollback: npm would revert ${resource} to previous version`)
    },
  }
}
