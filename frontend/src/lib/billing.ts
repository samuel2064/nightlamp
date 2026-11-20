// Billing view-model helpers (NOC-236). Pure functions only: they take server
// values and produce what the page may display. No commercial decision, plan
// name, tier alias, limit or amount is ever declared here.

import type {
  BillingInvoice,
  BillingLimits,
  BillingRole,
  BillingSubscription,
  BillingUsage,
} from '@/server/services/backend'

export type UsageLevel = 'no_plan' | 'over' | 'near' | 'ok'

export type SubscriptionLevel =
  | 'none'
  | 'active'
  | 'trialing'
  | 'scheduled_cancel'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'unknown'

export type AccessLevel = 'owner_admin' | 'member' | 'unavailable'

const NEAR_LIMIT_RATIO = 0.8

/** True only when the caller holds the elevated role the server requires. */
export function isElevatedRole(role: BillingRole | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

export function accessLevelFor(role: BillingRole | null | undefined): AccessLevel {
  if (isElevatedRole(role)) return 'owner_admin'
  if (role === 'member') return 'member'
  return 'unavailable'
}

/**
 * A subscription is countable only when the server sent a tier. A zeroed limit
 * block alone is a no-subscription read, never a real zero-limit plan.
 */
export function limitsAreKnown(limits: BillingLimits | null | undefined): boolean {
  if (!limits) return false
  return (
    Number.isFinite(limits.monitors) &&
    Number.isFinite(limits.reports) &&
    Number.isFinite(limits.storageMb)
  )
}

/**
 * A zeroed limit block is how the billing service answers for an account with no
 * subscription. It is never rendered as a real zero-limit plan.
 */
export function limitsDeclareNoPlan(limits: BillingLimits | null | undefined): boolean {
  if (!limitsAreKnown(limits)) return true
  return limits!.monitors === 0 && limits!.reports === 0 && limits!.storageMb === 0
}

export function subscriptionLevelFor(
  subscription: BillingSubscription | null | undefined
): SubscriptionLevel {
  if (!subscription) return 'none'
  switch (subscription.status) {
    case 'active':
      return subscription.cancelAtPeriodEnd ? 'scheduled_cancel' : 'active'
    case 'trialing':
      return 'trialing'
    case 'past_due':
      return 'past_due'
    case 'canceled':
      return 'canceled'
    case 'incomplete':
    case 'incomplete_expired':
      return 'incomplete'
    default:
      return 'unknown'
  }
}

export interface UsageRow {
  key: 'monitors' | 'reports' | 'storageMb'
  label: string
  used: number
  limit: number
  remaining: number
  level: UsageLevel
}

export function usageRows(usage: BillingUsage | null | undefined): UsageRow[] {
  const spec: Array<{ key: UsageRow['key']; label: string }> = [
    { key: 'monitors', label: 'Monitors' },
    { key: 'reports', label: 'Reports' },
    { key: 'storageMb', label: 'Storage' },
  ]
  if (!usage || !limitsAreKnown(usage.limits) || limitsDeclareNoPlan(usage.limits)) {
    return spec.map(({ key, label }) => ({
      key,
      label,
      used: 0,
      limit: 0,
      remaining: 0,
      level: 'no_plan' as UsageLevel,
    }))
  }
  return spec.map(({ key, label }) => {
    const used = Number(usage.usage?.[key] ?? 0)
    const limit = Number(usage.limits[key])
    const remaining = Math.max(0, limit - used)
    let level: UsageLevel = 'ok'
    // The tier enforcer refuses `used >= limit`, so the limit is reached at
    // equality, not strictly above it.
    if (limit > 0 && used >= limit) level = 'over'
    else if (limit > 0 && used >= limit * NEAR_LIMIT_RATIO) level = 'near'
    return { key, label, used, limit, remaining, level }
  })
}

/** Storage is the only usage measured in MB; everything else is a plain count. */
export function formatUsageValue(value: number, key: UsageRow['key']): string {
  if (key === 'storageMb') return formatStorageMb(value)
  return new Intl.NumberFormat('en-US').format(value)
}

export function formatStorageMb(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 MB'
  if (value >= 1024) {
    const gb = value / 1024
    return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(gb)} GB`
  }
  return `${new Intl.NumberFormat('en-US').format(value)} MB`
}

const PERIOD_LABELS: Record<string, string> = {
  month: 'per month',
  year: 'per year',
  day: 'per day',
  week: 'per week',
}

export function formatPeriod(period: string): string {
  return PERIOD_LABELS[period] ?? ''
}

/**
 * Plan prices arrive in major currency units (99, 299, 499) with a server-declared
 * currency. A missing or unrecognised currency keeps the plain server amount
 * rather than guessing a currency or a symbol.
 */
export function formatPlanPrice(price: number, currency: string): string {
  if (!Number.isFinite(price)) return '-'
  if (currency.length === 3) {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        minimumFractionDigits: Number.isInteger(price) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(price)
    } catch {
      // An unrecognised ISO code falls through to the plain amount.
    }
  }
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(price)
}

/**
 * Stripe invoice amounts arrive in minor units, so the scaling factor is a
 * property of the currency the server declared. Without that currency the amount
 * cannot be scaled honestly and is reported as unknown instead of guessed.
 */
export function formatInvoiceAmount(amount: number, currency: string): string {
  if (!Number.isFinite(amount)) return '-'
  if (currency.length !== 3) return 'Unknown currency'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount / 100)
  } catch {
    // An unrecognised ISO code is still an unknown amount, not a smaller one.
    return 'Unknown currency'
  }
}

export function formatInvoiceDate(created: number): string {
  if (!Number.isFinite(created) || created <= 0) return '-'
  const date = new Date(created * 1000)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date)
}

/**
 * A hosted invoice or PDF link is rendered only when it is an absolute https URL.
 * Anything else is not a link the customer can safely follow.
 */
export function isSafeInvoiceUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname.length > 0
  } catch {
    return false
  }
}

export function hasRenderableInvoiceLink(invoice: BillingInvoice): boolean {
  return isSafeInvoiceUrl(invoice.invoiceUrl) || isSafeInvoiceUrl(invoice.pdfUrl)
}

/** Status copy for a past-due subscription: never silent, never a fake success. */
export function pastDueCopy(subscription: BillingSubscription | null): string | null {
  if (!subscription) return null
  if (subscriptionLevelFor(subscription) === 'past_due') {
    return 'Payment is past due. Update your payment method in the Stripe portal to keep monitoring active.'
  }
  return null
}