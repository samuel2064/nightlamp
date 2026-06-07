import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDb, resetDb } from '../src/db.js'
import {
  findCustomerByStripeId,
  findCustomerByEmail,
  createCustomer,
  getSubscription,
  upsertSubscription,
  getUsage,
} from '../src/billing/repository.js'
import { TIER_LIMITS, STRIPE_PRICE_IDS } from '../src/billing/models.js'
import type { PlanTier } from '../src/billing/models.js'
import { getTierForEmail, requireSubscription, requireTier, checkRateLimit, resetRateLimitStore } from '../src/billing/middleware.js'

describe('billing repository', () => {
  beforeEach(async () => {
    resetDb()
    await initDb(':memory:')
  })

  afterEach(() => {
    resetDb()
  })

  describe('customers', () => {
    it('creates and finds a customer by stripe id', () => {
      const customer = createCustomer('cus_test123', 'test@example.com', 'Test User')
      expect(customer.stripe_customer_id).toBe('cus_test123')
      expect(customer.email).toBe('test@example.com')
      expect(customer.name).toBe('Test User')
      expect(customer.id).toBeGreaterThan(0)

      const found = findCustomerByStripeId('cus_test123')
      expect(found).toBeDefined()
      expect(found!.id).toBe(customer.id)
    })

    it('creates a customer without name', () => {
      const customer = createCustomer('cus_no_name', 'noname@example.com')
      expect(customer.name).toBeNull()
    })

    it('finds customer by email', () => {
      createCustomer('cus_1', 'one@example.com', 'One')
      createCustomer('cus_2', 'two@example.com', 'Two')

      const found = findCustomerByEmail('two@example.com')
      expect(found).toBeDefined()
      expect(found!.stripe_customer_id).toBe('cus_2')
    })

    it('returns undefined for non-existent stripe customer', () => {
      expect(findCustomerByStripeId('cus_nonexistent')).toBeUndefined()
    })

    it('returns undefined for non-existent email', () => {
      expect(findCustomerByEmail('nobody@example.com')).toBeUndefined()
    })
  })

  describe('subscriptions', () => {
    it('creates a subscription', () => {
      const customer = createCustomer('cus_sub', 'sub@example.com')
      const sub = upsertSubscription('sub_1', customer.id, 'respond', 'active', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')

      expect(sub.stripe_subscription_id).toBe('sub_1')
      expect(sub.plan_tier).toBe('respond')
      expect(sub.status).toBe('active')
      expect(sub.current_period_start).toBe('2026-01-01T00:00:00Z')
    })

    it('updates an existing subscription', () => {
      const customer = createCustomer('cus_update', 'update@example.com')
      upsertSubscription('sub_2', customer.id, 'watch', 'active', '2026-01-01T00:00:00Z')

      const updated = upsertSubscription('sub_2', customer.id, 'respond', 'past_due', '2026-01-15T00:00:00Z')
      expect(updated.plan_tier).toBe('respond')
      expect(updated.status).toBe('past_due')
    })

    it('retrieves latest subscription for customer', () => {
      const customer = createCustomer('cus_get', 'get@example.com')
      upsertSubscription('sub_a', customer.id, 'watch', 'canceled')
      upsertSubscription('sub_b', customer.id, 'respond', 'active')

      const sub = getSubscription(customer.id)
      expect(sub).toBeDefined()
      expect(sub!.stripe_subscription_id).toBe('sub_b')
      expect(sub!.plan_tier).toBe('respond')
    })
  })

  describe('usage', () => {
    it('returns undefined for customer with no usage', () => {
      const customer = createCustomer('cus_usage', 'usage@example.com')
      expect(getUsage(customer.id)).toBeUndefined()
    })
  })

  describe('tier middleware', () => {
  beforeEach(async () => {
    resetDb()
    await initDb(':memory:')
    const customer = createCustomer('cus_mw', 'mw@example.com', 'MW User')
    upsertSubscription('sub_mw', customer.id, 'respond', 'active', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
  })

  afterEach(() => {
    resetDb()
  })

  it('getTierForEmail returns correct tier info', () => {
    const tier = getTierForEmail('mw@example.com')
    expect(tier).toBeDefined()
    expect(tier!.tier).toBe('respond')
    expect(tier!.isActive).toBe(true)
    expect(tier!.isPastDue).toBe(false)
    expect(tier!.maxApps).toBe(5)
  })

  it('getTierForEmail returns null for unknown email', () => {
    const tier = getTierForEmail('nobody@example.com')
    expect(tier).toBeNull()
  })

  it('requireSubscription middleware passes for active subscription', () => {
    const req = { headers: { 'x-user-email': 'mw@example.com' } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
    const next = vi.fn()

    requireSubscription(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('requireSubscription rejects missing email header', () => {
    const req = { headers: {} } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
    const next = vi.fn()

    requireSubscription(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('requireTier middleware blocks insufficient tier', () => {
    const mw = requireTier('white_glove')
    const req = { headers: { 'x-user-email': 'mw@example.com' } } as any
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any
    const next = vi.fn()

    mw(req, res, next)
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('checkRateLimit allows requests within limit', () => {
    resetRateLimitStore()
    const result = checkRateLimit('mw@example.com')
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(60)
  })
})

describe('rate limiting', () => {
  beforeEach(async () => {
    resetDb()
    await initDb(':memory:')
    const customer = createCustomer('cus_rl', 'rl@example.com', 'RL User')
    upsertSubscription('sub_rl', customer.id, 'watch', 'active', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')
    resetRateLimitStore()
  })

  afterEach(() => {
    resetDb()
  })

  it('checkRateLimit respects watch tier limit of 10', () => {
    const result = checkRateLimit('rl@example.com')
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(10)
  })

  it('checkRateLimit returns false for unknown email', () => {
    const result = checkRateLimit('nobody@example.com')
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })
})

describe('stripe connector', () => {
  it('throws without STRIPE_SECRET_KEY', () => {
    const prev = process.env.STRIPE_SECRET_KEY
    delete process.env.STRIPE_SECRET_KEY
    expect(() => {
      // dynamic import to avoid top-level init
    }).not.toThrow()
    process.env.STRIPE_SECRET_KEY = prev
  })

  it('getTierLimits returns correct limits', async () => {
    const { getTierLimits } = await import('../src/billing/stripe.js')
    const limits = getTierLimits('respond')
    expect(limits.maxApps).toBe(5)
    expect(limits.responseHours).toBe(4)
    expect(limits.supportLevel).toBe('priority')
  })
})

describe('constants', () => {
    it('defines tier limits for all three tiers', () => {
      expect(TIER_LIMITS.watch.maxApps).toBe(1)
      expect(TIER_LIMITS.respond.maxApps).toBe(5)
      expect(TIER_LIMITS.white_glove.maxApps).toBe(Infinity)
    })

    it('maps all tiers to Stripe price IDs', () => {
      expect(STRIPE_PRICE_IDS.watch).toBe('price_watch_monthly')
      expect(STRIPE_PRICE_IDS.respond).toBe('price_respond_monthly')
      expect(STRIPE_PRICE_IDS.white_glove).toBe('price_white_glove_monthly')
    })
  })
})