const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

import type { DiagnosticEntry, PlaybookExecution } from '@/components/playbook/types'

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

/**
 * Tenant-scoped billing contract delivered by NOC-235 (src/billing/billing-api.ts
 * on origin/main). Every commercial value, limit, plan name and status string is
 * declared by the server; this module never hard-codes a price, a tier alias, a
 * limit or a plan name.
 *
 * Response identity fields (customer, subscription, Stripe and invoice ids) are
 * dropped by the mappers below so they can never reach the browser.
 */

export type BillingRole = 'owner' | 'admin' | 'member' | 'none'

export interface BillingPlan {
  id: string
  name: string
  /** Major currency units, as returned by the server. */
  price: number
  monitors: number
  reports: number
  storageMb: number
}

export interface BillingUsageCounters {
  monitors: number
  reports: number
  storageMb: number
}

export interface BillingLimits {
  monitors: number
  reports: number
  storageMb: number
}

export interface BillingSubscription {
  planTier: string
  status: string
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  limits: BillingLimits
  price: number
  currency: string
  billingPeriod: string
  nextBillingDate: string | null
}

export interface BillingUsage {
  usage: BillingUsageCounters
  limits: BillingLimits
  remaining: BillingUsageCounters
}

export interface BillingInvoice {
  number: string | null
  status: string
  currency: string
  /** Stripe minor units, converted for display with `formatMinorUnits`. */
  amountDue: number
  amountPaid: number
  /** Unix seconds. */
  created: number
  invoiceUrl: string | null
  pdfUrl: string | null
}

export type BillingErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'
  | 'invalid_request'
  | 'unknown'

/**
 * A failed billing request. The message carries a stable code only: upstream
 * bodies are drained and discarded so no raw backend response text is rendered,
 * logged or forwarded to the browser.
 */
export class BillingRequestError extends Error {
  readonly status: number | null
  readonly code: BillingErrorCode

  constructor(status: number | null, code: BillingErrorCode) {
    super(`Billing request failed (${code})`)
    this.name = 'BillingRequestError'
    this.status = status
    this.code = code
  }
}

export function billingErrorCode(status: number | null): BillingErrorCode {
  switch (status) {
    case 400:
    case 422:
      return 'invalid_request'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 500:
    case 502:
    case 503:
    case 504:
      return 'unavailable'
    default:
      return 'unknown'
  }
}

export function isBillingRequestError(err: unknown): err is BillingRequestError {
  return err instanceof BillingRequestError
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const str = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback
const optStr = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null
const bool = (value: unknown): boolean => value === true

function toCounters(value: unknown): BillingUsageCounters {
  const raw = (value ?? {}) as Record<string, unknown>
  return {
    monitors: num(raw.monitors),
    reports: num(raw.reports),
    storageMb: num(raw.storageMb),
  }
}

/** Drops the customer/subscription/Stripe identity fields before they leave the server. */
export function toBillingSubscription(value: unknown): BillingSubscription | null {
  const raw = value as Record<string, unknown> | null | undefined
  if (!raw || typeof raw !== 'object') return null
  return {
    planTier: str(raw.planTier, ''),
    status: str(raw.status, 'unknown'),
    currentPeriodStart: optStr(raw.currentPeriodStart),
    currentPeriodEnd: optStr(raw.currentPeriodEnd),
    cancelAtPeriodEnd: bool(raw.cancelAtPeriodEnd),
    limits: toCounters(raw.limits),
    price: num(raw.price),
    currency: str(raw.currency, ''),
    billingPeriod: str(raw.billingPeriod, ''),
    nextBillingDate: optStr(raw.nextBillingDate),
  }
}

/** Keeps the customer-visible invoice number, never the Stripe/invoice row id. */
export function toBillingInvoice(value: unknown): BillingInvoice {
  const raw = (value ?? {}) as Record<string, unknown>
  return {
    number: optStr(raw.number),
    status: str(raw.status, 'unknown'),
    currency: str(raw.currency, ''),
    amountDue: num(raw.amountDue),
    amountPaid: num(raw.amountPaid),
    created: num(raw.created),
    invoiceUrl: optStr(raw.invoiceUrl),
    pdfUrl: optStr(raw.pdfUrl),
  }
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
    plans: () => Promise<BillingPlan[]>
    subscription: () => Promise<BillingSubscription | null>
    usage: () => Promise<BillingUsage>
    invoices: () => Promise<BillingInvoice[]>
    access: () => Promise<BillingRole | null>
    portalUrl: () => Promise<string>
    changePlan: (planTier: string) => Promise<BillingSubscription | null>
    cancel: () => Promise<BillingSubscription | null>
  }
  remediation: {
    listRuns: (input?: { status?: string; limit?: number; offset?: number }) => Promise<{ runs: RemediationRun[]; count: number }>
    approveRun: (id: string) => Promise<{ success: boolean }>
    rejectRun: (id: string) => Promise<{ success: boolean }>
    retryRun: (id: string) => Promise<{ success: boolean }>
    listPolicies: () => Promise<{ policies: unknown[] }>
    updatePolicy: (id: string, data: Record<string, unknown>) => Promise<{ success: boolean }>
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

  const apiFetchPost = <T>(path: string, body: unknown): Promise<T> =>
    apiFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })

  /**
   * Billing uses its own fetch so a non-2xx response is reported as a status plus
   * a stable code. The upstream body is drained and dropped: backend error text
   * can contain endpoint inventories and internal detail, and none of it may be
   * rendered, logged, or forwarded to the browser.
   */
  const billingFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init?.headers as Record<string, string> | undefined),
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    const res = await fetch(`${BACKEND_URL}${path}`, { ...init, headers })
    if (!res.ok) {
      try {
        await res.text()
      } catch {
        // A body we cannot drain is still a body we never surface.
      }
      throw new BillingRequestError(res.status, billingErrorCode(res.status))
    }
    return (await res.json()) as T
  }

  const billingPost = <T>(path: string, body: unknown): Promise<T> =>
    billingFetch<T>(path, { method: 'POST', body: JSON.stringify(body) })

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
      plans: async () => {
        const { plans } = await billingFetch<{ plans?: unknown[] }>('/api/billing/plans')
        return (Array.isArray(plans) ? plans : []).map((plan) => {
          const raw = (plan ?? {}) as Record<string, unknown>
          return {
            id: str(raw.id, ''),
            name: str(raw.name, ''),
            price: num(raw.price),
            monitors: num(raw.monitors),
            reports: num(raw.reports),
            storageMb: num(raw.storageMb),
          }
        })
      },
      subscription: async () => {
        const { subscription } = await billingFetch<{ subscription?: unknown }>(
          '/api/billing/subscription'
        )
        return toBillingSubscription(subscription)
      },
      usage: async () => {
        const body = await billingFetch<Record<string, unknown>>('/api/billing/usage')
        return {
          usage: toCounters(body.usage),
          limits: toCounters(body.limits),
          remaining: toCounters(body.remaining),
        }
      },
      invoices: async () => {
        const { invoices } = await billingFetch<{ invoices?: unknown[] }>('/api/billing/invoices')
        return (Array.isArray(invoices) ? invoices : []).map(toBillingInvoice)
      },
      // NOC-354 delivers this endpoint. Until it exists the request is a 404 and
      // the caller fails closed to a read-only page.
      access: async () => {
        const { role } = await billingFetch<{ role?: unknown }>('/api/billing/access')
        return typeof role === 'string' ? (role as BillingRole) : null
      },
      portalUrl: async () => {
        const { url } = await billingFetch<{ url?: unknown }>('/api/billing/portal')
        if (typeof url !== 'string' || url.length === 0) {
          throw new BillingRequestError(null, 'unknown')
        }
        return url
      },
      changePlan: async (planTier: string) => {
        const body = await billingPost<Record<string, unknown>>('/api/billing/change-plan', {
          planTier,
        })
        return toBillingSubscription(body.subscription)
      },
      cancel: async () => {
        const body = await billingPost<Record<string, unknown>>('/api/billing/cancel', {})
        return toBillingSubscription(body.subscription)
      },
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
  }
}
