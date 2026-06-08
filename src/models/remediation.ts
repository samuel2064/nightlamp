export interface RemediationAction {
  id: string
  failureType: string
  actionName: string
  description?: string
  riskLevel: 'low' | 'medium' | 'high'
  enabled: boolean
}

export interface RemediationRun {
  id: string
  playbookEntryId?: string
  actionName: string
  status: 'pending' | 'pending_approval' | 'running' | 'success' | 'failed' | 'rolled_back'
  initiatedBy?: string
  approvedBy?: string
  output?: string
  error?: string
  startedAt?: string
  completedAt?: string
  createdAt: string
}

export interface RemediationPolicy {
  id: string
  failureType: string
  autoApprove: boolean
  requireDryRun: boolean
  cooldownMinutes: number
}
