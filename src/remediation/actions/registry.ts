export interface RemediationFailure {
  failure_type: string
  affected_resource?: string
  description?: string
}

export interface RemediationResult {
  success: boolean
  output: string
  rollback?: () => Promise<void>
}

export type RemediationHandler = (failure: RemediationFailure) => Promise<RemediationResult>

interface RegisteredAction {
  name: string
  failureType: string
  handler: RemediationHandler
}

const actionRegistry: Map<string, RegisteredAction> = new Map()

export function registerAction(name: string, failureType: string, handler: RemediationHandler): void {
  actionRegistry.set(failureType, { name, failureType, handler })
}

export function getAction(failureType: string): RemediationHandler | undefined {
  return actionRegistry.get(failureType)?.handler
}

export function listActions(): RegisteredAction[] {
  return Array.from(actionRegistry.values())
}
