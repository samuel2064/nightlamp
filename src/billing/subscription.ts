import { Database } from 'sql.js';
import { v4 as uuid } from 'uuid';
import { tenantFilter } from '../api/tenant';

export type PlanTier = 'basic' | 'advanced' | 'white_glove';
export type SubscriptionStatus = 'incomplete' | 'active' | 'past_due' | 'canceled' | 'trialing' | 'incomplete_expired';

export const PLAN_TIERS: Record<PlanTier, { name: string; price: number; monitors: number; reports: number; storageMb: number }> = {
  basic: { name: 'Basic Support', price: 99, monitors: 5, reports: 100, storageMb: 100 },
  advanced: { name: 'Advanced Support', price: 299, monitors: 20, reports: 500, storageMb: 500 },
  white_glove: { name: 'White-Glove', price: 499, monitors: 100, reports: 2000, storageMb: 2000 },
};

export interface Customer {
  id: string;
  stripeCustomerId: string | null;
  email: string;
  name: string | null;
  createdAt: string;
}

export interface Subscription {
  id: string;
  customerId: string;
  stripeSubscriptionId: string | null;
  planTier: PlanTier;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
}

export class SubscriptionModel {
  constructor(private db: Database) {}

  createCustomer(email: string, name?: string, teamId: string | null = null): Customer {
    const id = uuid();
    this.db.run(
      'INSERT INTO customers (id, email, name, team_id) VALUES (?, ?, ?, ?)',
      [id, email, name || null, teamId],
    );
    return { id, stripeCustomerId: null, email, name: name || null, createdAt: new Date().toISOString() };
  }

  getCustomer(id: string, teamId: string | null = null): Customer | null {
    const scope = tenantFilter('team_id', teamId);
    const result = this.db.exec(`SELECT id, stripe_customer_id, email, name, created_at FROM customers WHERE id = ? AND ${scope.clause}`, [id, ...scope.params]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return { id: row[0] as string, stripeCustomerId: row[1] as string | null, email: row[2] as string, name: row[3] as string | null, createdAt: row[4] as string };
  }

  getCustomerByStripeId(stripeCustomerId: string, teamId: string | null = null): Customer | null {
    const scope = tenantFilter('team_id', teamId);
    const result = this.db.exec(`SELECT id, stripe_customer_id, email, name, created_at FROM customers WHERE stripe_customer_id = ? AND ${scope.clause}`, [stripeCustomerId, ...scope.params]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return { id: row[0] as string, stripeCustomerId: row[1] as string | null, email: row[2] as string, name: row[3] as string | null, createdAt: row[4] as string };
  }

  updateStripeCustomerId(id: string, stripeCustomerId: string, teamId: string | null = null): void {
    const scope = tenantFilter('team_id', teamId);
    this.db.run(
      `UPDATE customers SET stripe_customer_id = ?, updated_at = datetime('now') WHERE id = ? AND ${scope.clause}`,
      [stripeCustomerId, id, ...scope.params],
    );
  }

  createSubscription(customerId: string, planTier: PlanTier, teamId: string | null = null): Subscription {
    const id = uuid();
    this.db.run(
      'INSERT INTO subscriptions (id, customer_id, plan_tier, team_id) VALUES (?, ?, ?, ?)',
      [id, customerId, planTier, teamId],
    );
    return { id, customerId, stripeSubscriptionId: null, planTier, status: 'incomplete', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, createdAt: new Date().toISOString() };
  }

  getSubscription(id: string, teamId: string | null = null): Subscription | null {
    const scope = tenantFilter('team_id', teamId);
    const result = this.db.exec(
      `SELECT id, customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at FROM subscriptions WHERE id = ? AND ${scope.clause}`,
      [id, ...scope.params],
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      customerId: row[1] as string,
      stripeSubscriptionId: row[2] as string | null,
      planTier: row[3] as PlanTier,
      status: row[4] as SubscriptionStatus,
      currentPeriodStart: row[5] as string | null,
      currentPeriodEnd: row[6] as string | null,
      cancelAtPeriodEnd: (row[7] as number) === 1,
      createdAt: row[8] as string,
    };
  }

  getSubscriptionByCustomer(customerId: string, teamId: string | null = null): Subscription | null {
    const scope = tenantFilter('team_id', teamId);
    const result = this.db.exec(
      `SELECT id, customer_id, stripe_subscription_id, plan_tier, status, current_period_start, current_period_end, cancel_at_period_end, created_at FROM subscriptions WHERE customer_id = ? AND ${scope.clause} ORDER BY created_at DESC LIMIT 1`,
      [customerId, ...scope.params],
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      customerId: row[1] as string,
      stripeSubscriptionId: row[2] as string | null,
      planTier: row[3] as PlanTier,
      status: row[4] as SubscriptionStatus,
      currentPeriodStart: row[5] as string | null,
      currentPeriodEnd: row[6] as string | null,
      cancelAtPeriodEnd: (row[7] as number) === 1,
      createdAt: row[8] as string,
    };
  }

  updateSubscriptionStatus(
    stripeSubscriptionId: string,
    status: SubscriptionStatus,
    periodStart?: string,
    periodEnd?: string,
    teamId: string | null = null,
  ): void {
    const params: any[] = [status];
    let sql = 'UPDATE subscriptions SET status = ?';

    if (periodStart) {
      sql += ', current_period_start = ?';
      params.push(periodStart);
    }
    if (periodEnd) {
      sql += ', current_period_end = ?';
      params.push(periodEnd);
    }

    const scope = tenantFilter('team_id', teamId);
    sql += `, updated_at = datetime('now') WHERE stripe_subscription_id = ? AND ${scope.clause}`;
    params.push(stripeSubscriptionId, ...scope.params);

    this.db.run(sql, params);
  }

  updateStripeSubscriptionId(id: string, stripeSubscriptionId: string, status: SubscriptionStatus, teamId: string | null = null): void {
    const scope = tenantFilter('team_id', teamId);
    this.db.run(
      `UPDATE subscriptions SET stripe_subscription_id = ?, status = ?, updated_at = datetime('now') WHERE id = ? AND ${scope.clause}`,
      [stripeSubscriptionId, status, id, ...scope.params],
    );
  }

  cancelSubscription(id: string, cancelAtPeriodEnd: boolean, teamId: string | null = null): void {
    const scope = tenantFilter('team_id', teamId);
    this.db.run(
      `UPDATE subscriptions SET status = ?, cancel_at_period_end = ?, updated_at = datetime('now') WHERE id = ? AND ${scope.clause}`,
      [cancelAtPeriodEnd ? 'active' : 'canceled', cancelAtPeriodEnd ? 1 : 0, id, ...scope.params],
    );
  }
}