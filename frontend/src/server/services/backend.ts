const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

import type { DiagnosticEntry, PlaybookExecution } from '@/components/playbook/types'
import type { FeedbackReceipt, FeedbackSubmission } from '@/lib/feedback/contract'

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
  breakingChange: boolean
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

export interface RemediationRun {
  id: string
  playbook_entry_id?: string | null
  action_name: string
  status: string
  initiated_by?: string | null
  approved_by?: string | null
  output?: string | null
  error?: string | null
  created_at: string
  started_at?: string | null
  completed_at?: string | null
  affected_resource?: string | null
  failure_type?: string | null
  description?: string | null
  severity?: string | null
}

export interface BackendClient {
  events: {
    list: (params?: { limit?: number; offset?: number; type?: string; severity?: string }) => Promise<{ events: FailureEvent[]; count: number }>
  }
  checkResults: {
    list: (params?: { limit?: number; offset?: number; status?: string }) => Promise<{ results: CheckResult[]; count: number }>
  }
  playbook: {
    list: () => Promise<{ entries: DiagnosticEntry[]; count: number }>
    search: (q: string) => Promise<{ entries: DiagnosticEntry[]; count: number }>
    get: (id: string) => Promise<DiagnosticEntry>
    run: (playbookId: string, context?: Record<string, unknown>) => Promise<PlaybookExecution>
    decision: (executionId: string, decision: string) => Promise<PlaybookExecution>
    getExecution: (executionId: string) => Promise<PlaybookExecution>
  }
  health: {
    get: () => Promise<HealthStats>
  }
  billing: {
    summary: () => Promise<BillingData>
    listSubscriptions: () => Promise<{ subscriptions: unknown[] }>
    portalUrl: () => Promise<{ url: string }>
  }
  remediation: {
    listRuns: (input?: { status?: string; limit?: number; offset?: number }) => Promise<{ runs: RemediationRun[]; count: number }>
    approveRun: (id: string) => Promise<{ success: boolean }>
    rejectRun: (id: string) => Promise<{ success: boolean }>
    retryRun: (id: string) => Promise<{ success: boolean }>
    listPolicies: () => Promise<{ policies: unknown[] }>
    updatePolicy: (id: string, data: Record<string, unknown>) => Promise<{ success: boolean }>
  }
  feedback: {
    submit: (input: FeedbackSubmission) => Promise<FeedbackReceipt>
    receipt: (responseId: string) => Promise<{ item: FeedbackResponseRecord }>
  }
}

export interface FeedbackResponseRecord {
  response_id: string
  kind: 'feedback' | 'survey'
  feedback_type: string | null
  survey_id: string | null
  score: number | null
  received_at: string
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

  const apiFetchPost = <T>(path: string, body: unknown): Promise<T> =>
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
    playbook: {
      list: () =>
        apiFetch<{ entries: DiagnosticEntry[]; count: number }>('/api/playbook'),
      search: (q: string) =>
        apiFetch<{ entries: DiagnosticEntry[]; count: number }>(`/api/playbook/search?q=${encodeURIComponent(q)}`),
      get: async (id: string) => {
        const { entries } = await apiFetch<{ entries: DiagnosticEntry[]; count: number }>('/api/playbook')
        const entry = entries.find(entry => entry.id === id)
        if (!entry) throw new Error(`Playbook entry ${id} not found`)
        return entry
      },
      run: async (playbookId: string, context: Record<string, unknown> = {}) => {
        const { execution } = await apiFetchPost<{ execution: PlaybookExecution }>(
          '/api/playbook/executions',
          { playbookId, context }
        )
        return execution
      },
      decision: async (executionId: string, decision: string) => {
        const { execution } = await apiFetchPost<{ execution: PlaybookExecution }>(
          `/api/playbook/executions/${encodeURIComponent(executionId)}/decision`,
          { decision }
        )
        return execution
      },
      getExecution: async (executionId: string) => {
        const { execution } = await apiFetch<{ execution: PlaybookExecution }>(
          `/api/playbook/executions/${encodeURIComponent(executionId)}`
        )
        return execution
      },
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
    remediation: {
      listRuns: (input?: { status?: string; limit?: number; offset?: number }) => {
        const params = new URLSearchParams()
        if (input?.status) params.set('status', input.status)
        if (input?.limit !== undefined) params.set('limit', String(input.limit))
        if (input?.offset !== undefined) params.set('offset', String(input.offset))
        return apiFetch<{ runs: RemediationRun[]; count: number }>(
          `/api/remediation/runs?${params.toString()}`
        )
      },
      approveRun: (id: string) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/approve', { id }),
      rejectRun: (id: string) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/reject', { id }),
      retryRun: (id: string) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/retry', { id }),
      listPolicies: () =>
        apiFetch<{ policies: unknown[] }>('/api/remediation/policies'),
      updatePolicy: (id: string, data: Record<string, unknown>) =>
        apiFetchPost<{ success: boolean }>('/api/remediation/policies', { id, ...data }),
    },
    feedback: {
      submit: (input: FeedbackSubmission) =>
        apiFetchPost<FeedbackReceipt>('/api/feedback/responses', input),
      receipt: (responseId: string) =>
        apiFetch<{ item: FeedbackResponseRecord }>(
          `/api/feedback/responses/${encodeURIComponent(responseId)}`
        ),
    },
  }
}
