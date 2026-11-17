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
const failureTypeRegistry: Map<string, RegisteredAction> = new Map()

export function registerAction(name: string, failureType: string, handler: RemediationHandler): void {
  const action = { name, failureType, handler }
  actionRegistry.set(name, action)
  failureTypeRegistry.set(failureType, action)
}

export function getAction(nameOrFailureType: string): RemediationHandler | undefined {
  return actionRegistry.get(nameOrFailureType)?.handler
    ?? failureTypeRegistry.get(nameOrFailureType)?.handler
}

export function listActions(): RegisteredAction[] {
  return Array.from(failureTypeRegistry.values())
}
