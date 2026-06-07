import { getDb, saveDb } from '../db.js'
import type { Customer, Subscription, UsageRecord, PlanTier, SubscriptionStatus } from './models.js'

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

export function findCustomerByStripeId(stripeCustomerId: string): Customer | undefined {
  const row = firstRow(
    'SELECT id, stripe_customer_id, email, name, created_at FROM customers WHERE stripe_customer_id = ?',
    [stripeCustomerId],
  )
  if (!row) return undefined
  return row as unknown as Customer
}

export function findCustomerByEmail(email: string): Customer | undefined {
  const row = firstRow(
    'SELECT id, stripe_customer_id, email, name, created_at FROM customers WHERE email = ?',
    [email],
  )
  if (!row) return undefined
  return row as unknown as Customer
}

export function createCustomer(stripeCustomerId: string, email: string, name?: string): Customer {
  const db = getDb()
  db.run('INSERT INTO customers (stripe_customer_id, email, name) VALUES (?, ?, ?)', [stripeCustomerId, email, name || null])
  saveDb()
  return findCustomerByStripeId(stripeCustomerId)!
}

export function getSubscription(customerId: number): Subscription | undefined {
  const row = firstRow(
    `SELECT id, customer_id, stripe_subscription_id, plan_tier, status,
            current_period_start, current_period_end, created_at, updated_at
     FROM subscriptions WHERE customer_id = ? ORDER BY id DESC LIMIT 1`,
    [customerId],
  )
  if (!row) return undefined
  return row as unknown as Subscription
}

export function upsertSubscription(
  stripeSubscriptionId: string,
  customerId: number,
  planTier: PlanTier,
  status: SubscriptionStatus,
  periodStart?: string,
  periodEnd?: string,
): Subscription {
  const db = getDb()
  const existing = firstRow('SELECT id FROM subscriptions WHERE stripe_subscription_id = ?', [stripeSubscriptionId])

  if (existing) {
    db.run(
      `UPDATE subscriptions SET plan_tier = ?, status = ?, current_period_start = ?,
       current_period_end = ?, updated_at = datetime('now')
       WHERE stripe_subscription_id = ?`,
      [planTier, status, periodStart || null, periodEnd || null, stripeSubscriptionId],
    )
  } else {
    db.run(
      `INSERT INTO subscriptions (customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customerId, stripeSubscriptionId, planTier, status, periodStart || null, periodEnd || null],
    )
  }

  saveDb()
  const row = firstRow(
    `SELECT id, customer_id, stripe_subscription_id, plan_tier, status,
            current_period_start, current_period_end, created_at, updated_at
     FROM subscriptions WHERE stripe_subscription_id = ?`,
    [stripeSubscriptionId],
  )
  return row as unknown as Subscription
}

export function getUsage(customerId: number): UsageRecord | undefined {
  const row = firstRow(
    `SELECT id, customer_id, monitors_used, reports_generated, storage_mb, period_start, period_end
     FROM usage_records WHERE customer_id = ? ORDER BY period_start DESC LIMIT 1`,
    [customerId],
  )
  if (!row) return undefined
  return row as unknown as UsageRecord
}