import { Router } from 'express'
import { createCheckoutSession, createPortalSession, getStripeClient } from './stripe.js'
import { createCustomer, findCustomerByEmail, findCustomerByStripeId, getSubscription, upsertSubscription, getUsage } from './repository.js'
import { getDb } from '../db.js'
import type { PlanTier, Subscription } from './models.js'

const router = Router()

function firstRow(sql: string, params?: (string | number | null)[]): Record<string, unknown> | undefined {
  const db = getDb()
  const stmt = db.prepare(sql)
  if (params) stmt.bind(params)
  if (stmt.step()) {
    const cols = stmt.getColumnNames()
    const vals = stmt.get()
    stmt.free()
    const row: Record<string, unknown> = {}
    for (let i = 0; i < cols.length; i++) row[cols[i]] = vals[i]
    return row
  }
  stmt.free()
  return undefined
}

function findSubscriptionByStripeId(stripeSubscriptionId: string): Subscription | undefined {
  const row = firstRow(
    `SELECT id, customer_id, stripe_subscription_id, plan_tier, status,
            current_period_start, current_period_end, created_at, updated_at
     FROM subscriptions WHERE stripe_subscription_id = ?`,
    [stripeSubscriptionId],
  )
  if (!row) return undefined
  return row as unknown as Subscription
}

router.post('/create-checkout-session', async (req, res) => {
  try {
    const { email, planTier } = req.body as { email?: string; planTier?: string }

    if (!email || !planTier) {
      res.status(400).json({ error: 'email and planTier are required' })
      return
    }

    if (!['watch', 'respond', 'white_glove'].includes(planTier)) {
      res.status(400).json({ error: 'planTier must be watch, respond, or white_glove' })
      return
    }

    const originUrl = `${req.protocol}://${req.get('host')}`
    const sessionUrl = await createCheckoutSession(email, planTier as PlanTier, originUrl)
    res.json({ url: sessionUrl })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/portal', async (req, res) => {
  try {
    const email = req.query.email as string
    if (!email) {
      res.status(400).json({ error: 'email query parameter is required' })
      return
    }

    const originUrl = `${req.protocol}://${req.get('host')}`
    const portalUrl = await createPortalSession(email, originUrl)
    res.json({ url: portalUrl })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.post('/webhook', async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'] as string | undefined
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    const stripe = getStripeClient()
    let event: { type: string; data: { object: Record<string, unknown> } }

    if (webhookSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig || '', webhookSecret) as unknown as typeof event
    } else {
      event = req.body as typeof event
    }

    const subscription = event.data.object as {
      id: string
      customer: string
      items?: { data: Array<{ price: { metadata: Record<string, string> } }> }
      metadata?: Record<string, string>
      status: string
      current_period_start?: number
      current_period_end?: number
    }

    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const customerId = subscription.customer as string
        const planTier = (subscription.metadata?.plan_tier || 'watch') as PlanTier

        const stripeCustomer = await stripe.customers.retrieve(customerId)
        if (stripeCustomer.deleted) break

        let localCustomer = findCustomerByStripeId(customerId)
        if (!localCustomer) {
          localCustomer = createCustomer(customerId, stripeCustomer.email || '', stripeCustomer.name || undefined)
        }

        upsertSubscription(
          subscription.id,
          localCustomer.id,
          planTier,
          subscription.status as 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete',
          subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : undefined,
          subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : undefined,
        )
        break
      }

      case 'customer.subscription.deleted': {
        const existing = findSubscriptionByStripeId(subscription.id)
        if (existing) {
          upsertSubscription(subscription.id, existing.customer_id, existing.plan_tier, 'canceled')
        }
        break
      }
    }

    res.json({ received: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

router.get('/subscription', async (req, res) => {
  try {
    const email = req.query.email as string
    if (!email) {
      res.status(400).json({ error: 'email query parameter is required' })
      return
    }

    const customer = findCustomerByEmail(email)
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' })
      return
    }

    const subscription = getSubscription(customer.id)
    if (!subscription) {
      res.status(404).json({ error: 'No active subscription found' })
      return
    }

    res.json(subscription)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/usage', async (req, res) => {
  try {
    const email = req.query.email as string
    if (!email) {
      res.status(400).json({ error: 'email query parameter is required' })
      return
    }

    const customer = findCustomerByEmail(email)
    if (!customer) {
      res.status(404).json({ error: 'Customer not found' })
      return
    }

    const usage = getUsage(customer.id)
    res.json(usage || { monitors_used: 0, reports_generated: 0, storage_mb: 0 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

export default router