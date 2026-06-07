import Stripe from 'stripe'
import { STRIPE_PRICE_IDS, TIER_LIMITS } from './models.js'
import type { PlanTier } from './models.js'

let stripe: Stripe | null = null

export function getStripeClient(): Stripe {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY
    if (!key) throw new Error('STRIPE_SECRET_KEY environment variable is required')
    stripe = new Stripe(key, { apiVersion: '2025-04-10' as any })
  }
  return stripe
}

export async function createCheckoutSession(customerEmail: string, planTier: PlanTier, originUrl: string): Promise<string> {
  const client = getStripeClient()

  const customers = await client.customers.list({ email: customerEmail, limit: 1 })
  let customer = customers.data[0]

  if (!customer) {
    customer = await client.customers.create({ email: customerEmail })
  }

  const session = await client.checkout.sessions.create({
    customer: customer.id,
    mode: 'subscription',
    line_items: [{ price: STRIPE_PRICE_IDS[planTier], quantity: 1 }],
    success_url: `${originUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${originUrl}/billing/cancel`,
    subscription_data: {
      metadata: { plan_tier: planTier },
    },
  })

  return session.url!
}

export async function createPortalSession(customerEmail: string, originUrl: string): Promise<string> {
  const client = getStripeClient()

  const customers = await client.customers.list({ email: customerEmail, limit: 1 })
  const customer = customers.data[0]
  if (!customer) throw new Error('Customer not found')

  const session = await client.billingPortal.sessions.create({
    customer: customer.id,
    return_url: `${originUrl}/billing/settings`,
  })

  return session.url!
}

export function getTierLimits(tier: PlanTier) {
  return TIER_LIMITS[tier]
}