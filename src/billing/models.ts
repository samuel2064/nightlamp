export type PlanTier = 'watch' | 'respond' | 'white_glove'
export type SubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete_expired'

export interface Customer {
  id: number
  stripe_customer_id: string
  email: string
  name: string | null
  created_at: string
}

export interface Subscription {
  id: number
  customer_id: number
  stripe_subscription_id: string
  plan_tier: PlanTier
  status: SubscriptionStatus
  current_period_start: string | null
  current_period_end: string | null
  created_at: string
  updated_at: string
}

export interface UsageRecord {
  id: number
  customer_id: number
  monitors_used: number
  reports_generated: number
  storage_mb: number
  period_start: string
  period_end: string
}

export const TIER_LIMITS: Record<PlanTier, { maxApps: number; responseHours: number; supportLevel: string; whiteLabel: boolean }> = {
  watch: { maxApps: 1, responseHours: 48, supportLevel: 'email', whiteLabel: false },
  respond: { maxApps: 5, responseHours: 4, supportLevel: 'priority', whiteLabel: false },
  white_glove: { maxApps: Infinity, responseHours: 1, supportLevel: 'sla', whiteLabel: true },
}

export const STRIPE_PRICE_IDS: Record<PlanTier, string> = {
  watch: 'price_watch_monthly',
  respond: 'price_respond_monthly',
  white_glove: 'price_white_glove_monthly',
}