const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

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

export interface BackendClient {
  events: {
    list: (params?: { limit?: number; offset?: number; type?: string; severity?: string }) => Promise<{ events: FailureEvent[]; count: number }>
  }
  checkResults: {
    list: (params?: { limit?: number; offset?: number; status?: string }) => Promise<{ results: CheckResult[]; count: number }>
  }
  checks: {
    create: (data: { source: string; name: string; config: any; enabled?: boolean }) => Promise<{ id: string; source: string; name: string; config: any; enabled: boolean; createdAt: string; updatedAt: string }>
    testCheck: (data: { url: string; type: string; checkType?: string }) => Promise<{ success: boolean; statusCode?: number; latencyMs?: number; error?: string }>
  }
  playbook: {
    list: () => Promise<{ entries: PlaybookEntry[]; count: number }>
    search: (q: string) => Promise<{ entries: PlaybookEntry[]; count: number }>
    get: (id: string) => Promise<PlaybookEntry>
    run: (id: string) => Promise<PlaybookExecution>
    decision: (executionId: string, stepId: string, answer: string[], skipped?: boolean) => Promise<{ step: PlaybookStep | null; completed: boolean }>
    getExecution: (executionId: string) => Promise<PlaybookExecution>
  }
  health: {
    get: () => Promise<HealthStats>
  }
  billing: {
    summary: () => Promise<BillingData>
    listSubscriptions: () => Promise<{ subscriptions: any[] }>
    portalUrl: () => Promise<{ url: string }>
  }
  remediation: {
    listRuns: (input?: { status?: string; limit?: number; offset?: number }) => Promise<{ runs: any[]; count: number }>
    approveRun: (id: string) => Promise<{ success: boolean }>
    rejectRun: (id: string) => Promise<{ success: boolean }>
    retryRun: (id: string) => Promise<{ success: boolean }>
    listPolicies: () => Promise<{ policies: any[] }>
    updatePolicy: (id: string, data: any) => Promise<{ success: boolean }>
  }
}

export function createBackendClient(token: string | null): BackendClient {
  const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    const res = await fetch(`${BACKEND_URL}${path}`, {
      ...init,
      headers,
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Backend API error ${res.status}: ${body}`)
    }
    return res.json()
  }

  const apiFetchPost = <T>(path: string, body: any): Promise<T> =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })

  return {
    events: {
      list: (params?: { limit?: number; offset?: number; type?: string; severity?: string }) =>
        apiFetch<{ events: FailureEvent[]; count: number }>(
          `/api/events?${new URLSearchParams(params as Record<string, string>).toString()}`
        ),
    },
    checkResults: {
      list: (params?: { limit?: number; offset?: number; status?: string }) =>
        apiFetch<{ results: CheckResult[]; count: number }>(
          `/api/check-results?${new URLSearchParams(params as Record<string, string>).toString()}`
        ),
    },
    checks: {
      create: (data: { source: string; name: string; config: any; enabled?: boolean }) =>
        apiFetchPost<{ id: string; source: string; name: string; config: any; enabled: boolean; createdAt: string; updatedAt: string }>(
          '/api/checks',
          data
        ),
      testCheck: (data: { url: string; type: string; checkType?: string }) =>
        apiFetchPost<{ success: boolean; statusCode?: number; latencyMs?: number; error?: string }>(
          '/api/checks/test',
          data
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
        apiFetchPost<{ step: PlaybookStep | null; completed: boolean }>(
          `/api/playbooks/${executionId}/decision`,
          { stepId, answer, skipped }
        ),
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
        apiFetch<{ subscriptions: any[] }>('/api/billing/subscriptions'),
      portalUrl: () =>
        apiFetch<{ url: string }>('/api/billing/portal'),
    },
    remediation: {
      listRuns: (input?: { status?: string; limit?: number; offset?: number }) =>
        apiFetch<{ runs: any[]; count: number }>(
          `/api/playbook/remediation-logs?${new URLSearchParams((input || {}) as Record<string, string>).toString()}`
        ),
      approveRun: (id: string) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/approve', { id }),
      rejectRun: (id: string) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/reject', { id }),
      retryRun: (id: string) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/retry', { id }),
      listPolicies: () =>
        apiFetch<{ policies: any[] }>('/api/remediation/policies'),
      updatePolicy: (id: string, data: any) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/policies', { id, ...data }),
    },
  }
}
