import type { Request, Response, NextFunction } from 'express'
import { findCustomerByEmail, getSubscription } from '../billing/repository.js'
import { TIER_LIMITS } from '../billing/models.js'
import type { PlanTier } from '../billing/models.js'

export interface TierInfo {
  tier: PlanTier
  isActive: boolean
  isPastDue: boolean
  maxApps: number
  responseHours: number
  supportLevel: string
  whiteLabel: boolean
}

const GRACE_PERIOD_DAYS = 7

export function getTierForEmail(email: string): TierInfo | null {
  const customer = findCustomerByEmail(email)
  if (!customer) return null

  const subscription = getSubscription(customer.id)
  if (!subscription) return null

  const limits = TIER_LIMITS[subscription.plan_tier]
  const isPastDue = subscription.status === 'past_due'
  const isActive = subscription.status === 'active' || subscription.status === 'trialing'

  return {
    tier: subscription.plan_tier,
    isActive,
    isPastDue,
    maxApps: limits.maxApps,
    responseHours: limits.responseHours,
    supportLevel: limits.supportLevel,
    whiteLabel: limits.whiteLabel,
  }
}

export function requireSubscription(req: Request, res: Response, next: NextFunction): void {
  const email = req.headers['x-user-email'] as string | undefined

  if (!email) {
    res.status(401).json({ error: 'x-user-email header is required' })
    return
  }

  const tier = getTierForEmail(email)
  if (!tier) {
    res.status(402).json({ error: 'No active subscription found', code: 'payment_required' })
    return
  }

  if (!tier.isActive && !tier.isPastDue) {
    res.status(403).json({ error: 'Subscription is not active', code: 'subscription_inactive' })
    return
  }

  if (tier.isPastDue) {
    const customer = findCustomerByEmail(email)
    if (customer) {
      const subscription = getSubscription(customer.id)
      if (subscription?.current_period_end) {
        const graceEnd = new Date(subscription.current_period_end)
        graceEnd.setDate(graceEnd.getDate() + GRACE_PERIOD_DAYS)
        if (new Date() > graceEnd) {
          res.status(403).json({ error: 'Grace period expired', code: 'grace_period_expired' })
          return
        }
      }
    }
  }

  next()
}

export function requireTier(minTier: PlanTier) {
  const tierOrder: Record<PlanTier, number> = { watch: 0, respond: 1, white_glove: 2 }

  return (req: Request, res: Response, next: NextFunction): void => {
    const email = req.headers['x-user-email'] as string | undefined
    if (!email) {
      res.status(401).json({ error: 'x-user-email header is required' })
      return
    }

    const tier = getTierForEmail(email)
    if (!tier || !tier.isActive) {
      res.status(403).json({ error: 'Active subscription required' })
      return
    }

    if (tierOrder[tier.tier] < tierOrder[minTier]) {
      res.status(403).json({
        error: `This feature requires at least the ${minTier} tier`,
        currentTier: tier.tier,
        requiredTier: minTier,
      })
      return
    }

    next()
  }
}

interface RateLimitEntry {
  key: string
  timestamp: number
}

const rateLimitStore: RateLimitEntry[] = []

export function resetRateLimitStore(): void {
  rateLimitStore.length = 0
}

export function checkRateLimit(email: string): { allowed: boolean; remaining: number; resetAt: string } {
  const tier = getTierForEmail(email)
  if (!tier) return { allowed: false, remaining: 0, resetAt: new Date().toISOString() }

  const rateLimits: Record<PlanTier, number> = {
    watch: 10,
    respond: 60,
    white_glove: 300,
  }

  const limit = rateLimits[tier.tier]
  const windowMs = 60_000
  const now = Date.now()
  const windowStart = now - windowMs

  const usageKey = `ratelimit:${email}`
  const hits = rateLimitStore.filter(r => r.key === usageKey && r.timestamp > windowStart).length
  const resetAt = new Date(now + windowMs).toISOString()

  return {
    allowed: hits < limit,
    remaining: Math.max(0, limit - hits),
    resetAt,
  }
}

export function recordRateLimitHit(email: string): void {
  rateLimitStore.push({ key: `ratelimit:${email}`, timestamp: Date.now() })
  if (rateLimitStore.length > 10000) rateLimitStore.splice(0, 5000)
}

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  const email = req.headers['x-user-email'] as string | undefined

  if (!email) {
    res.status(401).json({ error: 'x-user-email header is required' })
    return
  }

  const result = checkRateLimit(email)
  res.setHeader('X-RateLimit-Limit', '0')
  res.setHeader('X-RateLimit-Remaining', String(result.remaining))
  res.setHeader('X-RateLimit-Reset', result.resetAt)

  if (!result.allowed) {
    res.status(429).json({ error: 'Rate limit exceeded', code: 'rate_limited' })
    return
  }

  recordRateLimitHit(email)
  next()
}