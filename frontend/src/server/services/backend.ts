const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000'

async function fetchBackend<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Backend error ${res.status}: ${err}`)
  }
  return res.json()
}

export interface PlaybookEntry {
  id: number
  failureType: string
  source: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  title: string
  description: string
  affectedResource: string
  diagnosis: string
  remediation: string
  status: string
  relatedEntries: string
  createdAt: string
  updatedAt: string
  resolvedAt: string | null
}

export interface Subscription {
  id: number
  customer_id: number
  stripe_subscription_id: string
  plan_tier: string
  status: string
  current_period_start: string | null
  current_period_end: string | null
  created_at: string
  updated_at: string
}

export interface Usage {
  monitors_used: number
  reports_generated: number
  storage_mb: number
}

export interface ActivityEvent {
  id: string
  type: 'alert' | 'status' | 'deploy' | 'playbook'
  message: string
  resource: string
  severity: 'critical' | 'warning' | 'info' | 'success'
  time: string
}

export interface Incident {
  id: string
  title: string
  resource: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  status: 'open' | 'investigating' | 'resolved'
  source: string
  time: string
}

export interface Monitor {
  id: number
  friendlyName: string
  url: string
  status: 'up' | 'degraded' | 'down'
  uptimeRatio: number
  responseTime: number
  sslStatus: string
  sslDaysRemaining: number | null
  lastChecked: string
}

export interface MonitorHealthResult {
  monitors: Monitor[]
  overallStatus: 'up' | 'degraded' | 'down'
}

export interface DependencyHealth {
  total: number
  upToDate: number
  outdated: number
  bySeverity: Record<string, number>
  byType: { dependencies: number; devDependencies: number; peerDependencies: number }
  criticalItems: Array<{
    name: string
    currentVersion: string
    latestVersion: string
    severity: string
    summary: string
  }>
  recentUpdates: number
  lastChecked?: string
}

export const backend = {
  playbooks: {
    list: (params?: { source?: string; severity?: string; status?: string; limit?: number; offset?: number }) => {
      const qs = new URLSearchParams()
      if (params?.source) qs.set('source', params.source)
      if (params?.severity) qs.set('severity', params.severity)
      if (params?.status) qs.set('status', params.status)
      if (params?.limit) qs.set('limit', String(params.limit))
      if (params?.offset) qs.set('offset', String(params.offset))
      return fetchBackend<PlaybookEntry[]>(`/api/playbooks?${qs.toString()}`)
    },
    get: (id: number) => fetchBackend<PlaybookEntry>(`/api/playbooks/${id}`),
    failureTypes: () => fetchBackend<{ failureTypes: string[] }>('/api/playbooks/meta/failure-types'),
    create: (data: {
      failureType: string
      source: string
      severity: string
      title: string
      description?: string
      affectedResource: string
      diagnosis?: string
      remediation?: string
      relatedEntries?: string
    }) => fetchBackend<PlaybookEntry>('/api/playbooks', { method: 'POST', body: JSON.stringify(data) }),
    updateStatus: (id: number, status: string, resolvedAt?: string) =>
      fetchBackend<PlaybookEntry>(`/api/playbooks/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status, resolvedAt }) }),
    autoGenerate: (failureType: string, resource: string, details?: Record<string, unknown>) =>
      fetchBackend<PlaybookEntry>('/api/playbooks/auto-generate', { method: 'POST', body: JSON.stringify({ failureType, resource, details }) }),
  },
  billing: {
    subscription: (email: string) => fetchBackend<Subscription>(`/api/billing/subscription?email=${encodeURIComponent(email)}`),
    usage: (email: string) => fetchBackend<Usage>(`/api/billing/usage?email=${encodeURIComponent(email)}`),
  },
  dependencies: {
    health: () => fetchBackend<DependencyHealth>('/api/dependency-health'),
  },
  monitors: {
    health: () => fetchBackend<MonitorHealthResult>('/api/monitors'),
  },
  incidents: {
    list: () => fetchBackend<Incident[]>('/api/incidents'),
  },
  activity: {
    list: () => fetchBackend<ActivityEvent[]>('/api/activity'),
  },
}
