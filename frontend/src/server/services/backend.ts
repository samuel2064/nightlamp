const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Backend API error ${res.status}: ${body}`)
  }
  return res.json()
}

export interface FailureEvent {
  id: string
  checkId: string
  failureType: string
  severity: string
  title: string
  description: string
  detectedAt: string
  acknowledged: boolean
}

export interface CheckResult {
  id: string
  checkId: string
  status: string
  summary: string
  executedAt: string
}

export interface PlaybookEntry {
  id: string
  failureType: string
  title: string
  firstSeenAt: string
  lastOccurrenceAt: string
  occurrenceCount: number
}

export interface PlaybookStep {
  id: string
  index: number
  title: string
  type: 'QUESTION' | 'CHECK' | 'ACTION' | 'INFO' | 'BRANCH' | 'RESOLUTION'
  status: 'pending' | 'current' | 'completed' | 'skipped'
  question?: {
    text: string
    options: Array<{ value: string; label: string; description?: string }>
    allowMultiple: boolean
    allowCustom: boolean
  }
  check?: {
    id: string
    name: string
    target: string
    type: 'HTTP' | 'TCP' | 'CUSTOM'
    timeout: number
  }
  action?: {
    instructions: string
    confirmLabel: string
    requireConfirmation: boolean
  }
  info?: {
    content: string
  }
  branch?: {
    condition: string
    result: boolean
    truePath: string
    falsePath: string
    skippedSteps: string[]
  }
  resolution?: {
    outcome: 'success' | 'partial' | 'escalation'
    rootCause: string
    actionsTaken: string[]
    prevention: string[]
  }
}

export interface Playbook {
  id: string
  title: string
  version: string
  estimatedDuration: number
  successRate: number
  steps: PlaybookStep[]
}

export interface PlaybookExecution {
  id: string
  playbookId: string
  playbook: Playbook
  currentStepIndex: number
  completedIndices: number[]
  skippedIndices: number[]
  answers: Record<string, string[]>
  status: 'running' | 'completed' | 'paused'
  startedAt: string
  updatedAt: string
}

export interface BillingData {
  customers: number
  subscriptions: number
  mrr: number
  activeSubscriptions: number
  pastDue: number
  canceled: number
}

export interface DependencyData {
  id: string
  name: string
  currentVersion: string
  specifiedRange: string
  isDev: boolean
  createdAt: string
  updatedAt: string
}

export interface DependencyUpdateData {
  id: string
  dependencyId: string
  availableVersion: string
  currentVersion: string
  changeType: string
  isBreaking: boolean
  changelogUrl: string | null
  detectedAt: string
}

export interface ActivityEvent {
  id: string
  type: string
  summary: string
  timestamp: string
}

export interface MonitorData {
  id: string
  name: string
  source: string
  enabled: boolean
  lastStatus: string
  lastRun: string
}

export type HealthStatus = 'healthy' | 'degraded' | 'critical'

export interface HealthStats {
  status: HealthStatus
  timestamp: string
  stats: {
    checks: number
    failureEvents: number
    playbookEntries: number
    incidentsLast24h?: number
    criticalLast24h?: number
  }
  slo?: {
    errorRate24h?: number
  }
}

function normalizeHealthStatus(raw: string | undefined): HealthStatus {
  switch ((raw || '').toLowerCase()) {
    case 'ok':
    case 'healthy':
    case 'up':
      return 'healthy'
    case 'degraded':
    case 'warn':
    case 'warning':
      return 'degraded'
    default:
      return 'critical'
  }
}

async function apiFetchPost<T>(path: string, body: unknown): Promise<T> {
  return apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

function toSearchParams(params?: Record<string, string | number | undefined>): URLSearchParams {
  const sp = new URLSearchParams()
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) sp.append(key, String(value))
    }
  }
  return sp
}

export const backend = {
  events: {
    list: (params?: { limit?: number; offset?: number; type?: string; severity?: string }) =>
      apiFetch<{ events: FailureEvent[]; count: number }>(
        `/api/events?${toSearchParams(params).toString()}`
      ),
    acknowledge: (id: string) =>
      apiFetchPost<{ success: boolean; id: string }>('/api/events/acknowledge', { id }),
  },
  checkResults: {
    list: (params?: { limit?: number; offset?: number; status?: string }) =>
      apiFetch<{ results: CheckResult[]; count: number }>(
        `/api/check-results?${toSearchParams(params).toString()}`
      ),
  },
  playbook: {
    list: () =>
      apiFetch<{ entries: PlaybookEntry[]; count: number }>('/api/playbook'),
    search: (q: string) =>
      apiFetch<{ entries: PlaybookEntry[]; count: number }>(`/api/playbook/search?q=${encodeURIComponent(q)}`),
    get: async (id: string) => {
      const { entries } = await apiFetch<{ entries: PlaybookEntry[]; count: number }>('/api/playbook')
      const entry = entries.find(e => e.id === id)
      if (!entry) throw new Error(`Playbook entry ${id} not found`)
      return entry
    },
    run: (id: string) =>
      apiFetchPost<PlaybookExecution>(`/api/playbooks/${id}/run`, {}),
    decision: (executionId: string, stepId: string, answer: string[], skipped = false) =>
      apiFetchPost<{ step: PlaybookStep | null; completed: boolean }>(`/api/playbooks/${executionId}/decision`, { stepId, answer, skipped }),
    getExecution: (executionId: string) =>
      apiFetch<PlaybookExecution>(`/api/playbooks/${executionId}`),
  },
  health: {
    get: async () => {
      const health = await apiFetch<HealthStats>('/api/health')
      return { ...health, status: normalizeHealthStatus(health.status) }
    },
  },
  billing: {
    summary: () =>
      apiFetch<BillingData>('/api/billing/summary'),
    listSubscriptions: () =>
      apiFetch<{ subscriptions: unknown[] }>('/api/billing/subscriptions'),
    portalUrl: () =>
      apiFetch<{ url: string }>('/api/billing/portal'),
  },
  dependencies: {
    list: () =>
      apiFetch<{ dependencies: DependencyData[] }>('/api/dependencies').then(res => res.dependencies),
    updates: (breakingOnly = false) =>
      apiFetch<{ updates: DependencyUpdateData[] }>(`/api/dependencies/updates${breakingOnly ? '?breaking=true' : ''}`).then(res => res.updates),
  },
  remediation: {
    listRuns: (input?: { status?: string; limit?: number; offset?: number }) =>
      apiFetch<{ logs: unknown[]; count: number }>(
        `/api/playbook/remediation-logs?${toSearchParams(input).toString()}`
      ).then(res => ({ runs: res.logs ?? [], count: res.count ?? 0 })),
    approveRun: (id: string) =>
      apiFetchPost<{ success: boolean }>('/api/remediation/approve', { id }),
    rejectRun: (id: string) =>
      apiFetchPost<{ success: boolean }>('/api/remediation/reject', { id }),
    retryRun: (id: string) =>
      apiFetchPost<{ success: boolean }>('/api/remediation/retry', { id }),
    listPolicies: () =>
      apiFetch<{ policies: unknown[] }>('/api/remediation/policies'),
    updatePolicy: (id: string, data: unknown) =>
      apiFetchPost<{ success: boolean }>('/api/remediation/policies', { id, ...(data as Record<string, unknown>) }),
  },
}
