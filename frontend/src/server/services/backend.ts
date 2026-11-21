const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

/** A billing call that hangs is unavailable, never a success. */
const BILLING_TIMEOUT_MS = 15_000

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
  status: string
  currency: string
  /** Stripe minor units, converted for display with `formatInvoiceAmount`. */
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
  | 'provider_failure'
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

  constructor(status: number | null, code: BillingErrorCode, message?: string) {
    super(message ?? `Billing request failed (${code})`)
    this.name = 'BillingRequestError'
    this.status = status
    this.code = code
  }
}

/**
 * Maps a failure status to a stable code. The two 5xx families stay distinct
 * because the page must show different truths: 500/502 is the billing service
 * answering with a failure (its provider step did not complete), while 503/504
 * - like a network-level failure - means the billing service did not do the
 * work at all.
 */
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
      return 'provider_failure'
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

/**
 * A successful billing payload is validated before it is shaped for the
 * browser. A malformed success payload is a provider failure, never a silent
 * zero, an empty list, or an empty plan: coercing it would let the page claim
 * a plan, an amount or a limit the server never declared.
 */
function invalidPayload(what: string): BillingRequestError {
  return new BillingRequestError(null, 'provider_failure', `Billing payload was not usable (${what})`)
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidPayload(what)
  return value as Record<string, unknown>
}

function requireFiniteNumber(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidPayload(what)
  return value
}

function requireNonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidPayload(what)
  return value
}

function requireBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw invalidPayload(what)
  return value
}

function optString(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length === 0) throw invalidPayload(what)
  return value
}

function requireCounters(value: unknown, what: string): BillingUsageCounters {
  const raw = requireObject(value, what)
  return {
    monitors: requireFiniteNumber(raw.monitors, `${what}.monitors`),
    reports: requireFiniteNumber(raw.reports, `${what}.reports`),
    storageMb: requireFiniteNumber(raw.storageMb, `${what}.storageMb`),
  }
}

/**
 * Drops the customer/subscription/Stripe identity fields before they leave the
 * server. Only an explicit null subscription is a no-subscription read; a
 * present-but-malformed subscription object is a provider failure so the page
 * can never present a half-declared plan as the truth.
 */
export function toBillingSubscription(value: unknown): BillingSubscription | null {
  if (value === null || value === undefined) return null
  const raw = requireObject(value, 'subscription')
  return {
    planTier: requireNonEmptyString(raw.planTier, 'subscription.planTier'),
    status: requireNonEmptyString(raw.status, 'subscription.status'),
    currentPeriodStart: optString(raw.currentPeriodStart, 'subscription.currentPeriodStart'),
    currentPeriodEnd: optString(raw.currentPeriodEnd, 'subscription.currentPeriodEnd'),
    cancelAtPeriodEnd: requireBoolean(raw.cancelAtPeriodEnd, 'subscription.cancelAtPeriodEnd'),
    limits: requireCounters(raw.limits, 'subscription.limits'),
    price: requireFiniteNumber(raw.price, 'subscription.price'),
    currency: requireNonEmptyString(raw.currency, 'subscription.currency'),
    billingPeriod: requireNonEmptyString(raw.billingPeriod, 'subscription.billingPeriod'),
    nextBillingDate: optString(raw.nextBillingDate, 'subscription.nextBillingDate'),
  }
}

/**
 * Invoice identity fields stay on the server: the plan prohibits invoice
 * identifiers in the browser, so neither the Stripe row id nor the invoice
 * number is forwarded. Each entry is validated; a malformed entry fails the
 * read instead of rendering as a zero-amount invoice.
 */
export function toBillingInvoice(value: unknown): BillingInvoice {
  const raw = requireObject(value, 'invoice')
  const currency = requireNonEmptyString(raw.currency, 'invoice.currency')
  if (currency.length !== 3) throw invalidPayload('invoice.currency')
  return {
    status: requireNonEmptyString(raw.status, 'invoice.status'),
    currency,
    amountDue: requireFiniteNumber(raw.amountDue, 'invoice.amountDue'),
    amountPaid: requireFiniteNumber(raw.amountPaid, 'invoice.amountPaid'),
    created: requireFiniteNumber(raw.created, 'invoice.created'),
    invoiceUrl: optString(raw.invoiceUrl, 'invoice.invoiceUrl'),
    pdfUrl: optString(raw.pdfUrl, 'invoice.pdfUrl'),
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
    let res: Response
    try {
      res = await fetch(`${BACKEND_URL}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
      })
    } catch {
      // A network failure or timeout is a service that did not answer. It is
      // never turned into a zero, an empty list, or a fake success.
      throw new BillingRequestError(null, 'unavailable')
    }
    if (!res.ok) {
      try {
        await res.text()
      } catch {
        // A body we cannot drain is still a body we never surface.
      }
      throw new BillingRequestError(res.status, billingErrorCode(res.status))
    }
    try {
      return (await res.json()) as T
    } catch {
      // A 2xx response whose body is not usable JSON is a provider failure,
      // not an empty payload.
      throw new BillingRequestError(res.status, 'provider_failure')
    }
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
        const body = await billingFetch<Record<string, unknown>>('/api/billing/plans')
        const plans = body.plans
        if (!Array.isArray(plans)) throw invalidPayload('plans')
        return plans.map((plan) => {
          const raw = requireObject(plan, 'plan')
          return {
            id: requireNonEmptyString(raw.id, 'plan.id'),
            name: requireNonEmptyString(raw.name, 'plan.name'),
            price: requireFiniteNumber(raw.price, 'plan.price'),
            monitors: requireFiniteNumber(raw.monitors, 'plan.monitors'),
            reports: requireFiniteNumber(raw.reports, 'plan.reports'),
            storageMb: requireFiniteNumber(raw.storageMb, 'plan.storageMb'),
          }
        })
      },
      subscription: async () => {
        const body = await billingFetch<Record<string, unknown>>('/api/billing/subscription')
        if (!('subscription' in body)) throw invalidPayload('subscription')
        return toBillingSubscription(body.subscription)
      },
      usage: async () => {
        const body = await billingFetch<Record<string, unknown>>('/api/billing/usage')
        return {
          usage: requireCounters(body.usage, 'usage'),
          limits: requireCounters(body.limits, 'limits'),
          remaining: requireCounters(body.remaining, 'remaining'),
        }
      },
      invoices: async () => {
        const body = await billingFetch<Record<string, unknown>>('/api/billing/invoices')
        const invoices = body.invoices
        if (!Array.isArray(invoices)) throw invalidPayload('invoices')
        return invoices.map(toBillingInvoice)
      },
      // NOC-354 delivers this endpoint. Until it exists the request is a 404 and
      // the caller fails closed to a read-only page.
      access: async () => {
        const body = await billingFetch<Record<string, unknown>>('/api/billing/access')
        const role = body.role
        return role === 'owner' || role === 'admin' || role === 'member' || role === 'none'
          ? role
          : null
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
