import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuid } from 'uuid';
import { StripeClient, createCheckoutSession, createCustomerPortalSession, constructWebhookEvent } from './stripe-client';
import { SubscriptionModel, PlanTier, Subscription, PLAN_TIERS } from './subscription';
import { TierEnforcer } from './tier-enforcer';
import { UsageTracker } from './usage';
import { AuthContext } from '../api/auth';
import { tenantFilter } from '../api/tenant';

interface BillingApiDeps {
  db: Database;
  stripeClient: StripeClient;
  webhookSecret: string;
  baseUrl: string;
}

export class BillingApi {
  private subscriptions: SubscriptionModel;
  private tierEnforcer: TierEnforcer;
  private usage: UsageTracker;

  constructor(private deps: BillingApiDeps) {
    this.subscriptions = new SubscriptionModel(deps.db);
    this.tierEnforcer = new TierEnforcer();
    this.usage = new UsageTracker(deps.db);
  }

  handle(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null = null): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;
    const teamId = auth ? auth.teamId : null;

    if (path === '/api/billing/create-checkout-session' && req.method === 'POST') {
      this.handleCreateCheckout(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/portal' && req.method === 'GET') {
      this.handlePortalRedirect(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/webhook' && req.method === 'POST') {
      this.handleWebhook(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/webhook-events' && req.method === 'GET') {
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
      res.end(JSON.stringify({ events: this.getWebhookEvents(limit, teamId) }));
      return true;
    }

    if (path === '/api/billing/subscription' && req.method === 'GET') {
      this.handleGetSubscription(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/usage' && req.method === 'GET') {
      this.handleGetUsage(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/plans' && req.method === 'GET') {
      this.handleListPlans(res);
      return true;
    }

    if (path === '/api/billing/customer' && req.method === 'POST') {
      this.handleCreateCustomer(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/summary' && req.method === 'GET') {
      this.handleSummary(res, teamId);
      return true;
    }

    if (path === '/api/billing/subscriptions' && req.method === 'GET') {
      this.handleListSubscriptions(res, teamId);
      return true;
    }

    return false;
  }

  private handleListPlans(res: ServerResponse): void {
    const plans = Object.entries(PLAN_TIERS).map(([tier, config]) => ({
      id: tier,
      name: config.name,
      price: config.price,
      monitors: config.monitors,
      reports: config.reports,
      storageMb: config.storageMb,
    }));
    res.end(JSON.stringify({ plans }));
  }

  private handleCreateCustomer(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { email, name } = JSON.parse(body);
        if (!email) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'email is required' }));
          return;
        }
        const customer = this.subscriptions.createCustomer(email, name, teamId);
        res.end(JSON.stringify({ customer }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleCreateCheckout(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { customerId, planTier } = JSON.parse(body);
        if (!customerId || !planTier) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'customerId and planTier are required' }));
          return;
        }

        const customer = this.subscriptions.getCustomer(customerId, teamId);
        if (!customer) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Customer not found' }));
          return;
        }

        if (!PLAN_TIERS[planTier as PlanTier]) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Invalid plan tier: ${planTier}` }));
          return;
        }

        const successUrl = `${this.deps.baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${this.deps.baseUrl}/billing/cancel`;

        const sub = this.subscriptions.createSubscription(customerId, planTier as PlanTier, teamId);

        const session = await createCheckoutSession(
          this.deps.stripeClient,
          customer.stripeCustomerId || undefined as any,
          planTier,
          successUrl,
          cancelUrl,
        );

        this.subscriptions.updateStripeSubscriptionId(sub.id, session.id, 'incomplete', teamId);

        res.end(JSON.stringify({ url: session.url, sessionId: session.id, subscriptionId: sub.id }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handlePortalRedirect(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const customerId = parsedUrl.searchParams.get('customerId');

    if (!customerId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'customerId is required' }));
      return;
    }

    const customer = this.subscriptions.getCustomer(customerId, teamId);
    if (!customer || !customer.stripeCustomerId) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Customer not found or no Stripe customer ID' }));
      return;
    }

    createCustomerPortalSession(
      this.deps.stripeClient,
      customer.stripeCustomerId,
      `${this.deps.baseUrl}/billing/portal`,
    ).then((session) => {
      res.end(JSON.stringify({ url: session.url }));
    }).catch((err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing stripe-signature header' }));
        return;
      }

      let event: any;
      try {
        event = await constructWebhookEvent(
          this.deps.stripeClient,
          body,
          signature,
          this.deps.webhookSecret,
        );
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const eventId: string = event.id || `evt_${uuid()}`;
      const livemode: boolean = event.livemode === true;

      // Idempotency: a previously processed event id is acknowledged without
      // re-running side effects (Stripe retries deliveries at-least-once).
      const eventScope = tenantFilter('team_id', teamId);
      const existing = this.deps.db.exec(
        `SELECT status FROM webhook_events WHERE id = ? AND ${eventScope.clause}`,
        [eventId, ...eventScope.params],
      );
      if (existing.length > 0 && existing[0].values.length > 0) {
        const priorStatus = existing[0].values[0][0] as string;
        if (priorStatus === 'processed' || priorStatus === 'skipped') {
          res.end(JSON.stringify({ received: true, duplicate: true, mode: livemode ? 'live' : 'test' }));
          return;
        }
      } else {
        this.deps.db.run(
          `INSERT INTO webhook_events (id, provider, event_type, livemode, status, payload, received_at, team_id)
           VALUES (?, 'stripe', ?, ?, 'received', ?, datetime('now'), ?)`,
          [eventId, event.type, livemode ? 1 : 0, body, teamId],
        );
      }

      try {
        this.applyWebhookEvent(event, teamId);
        this.deps.db.run(
          `UPDATE webhook_events SET status = 'processed', processed_at = datetime('now'), error = NULL WHERE id = ? AND ${eventScope.clause}`,
          [eventId, ...eventScope.params],
        );
      } catch (err: any) {
        this.deps.db.run(
          `UPDATE webhook_events SET status = 'failed', error = ?, processed_at = datetime('now') WHERE id = ? AND ${eventScope.clause}`,
          [err.message, eventId, ...eventScope.params],
        );
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      res.end(JSON.stringify({ received: true, mode: livemode ? 'live' : 'test' }));
    });
  }

  private applyWebhookEvent(event: any, teamId: string | null): void {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        if (session.mode === 'subscription') {
          this.subscriptions.updateSubscriptionStatus(
            session.id,
            'active',
            session.created ? new Date(session.created * 1000).toISOString() : undefined,
            undefined,
            teamId,
          );
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object as any;
          this.subscriptions.updateSubscriptionStatus(
            sub.id,
            sub.status,
            sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : undefined,
            sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : undefined,
            teamId,
          );
        break;
      }
      case 'customer.subscription.deleted': {
        const deletedSub = event.data.object as any;
        this.subscriptions.updateSubscriptionStatus(deletedSub.id, 'canceled', undefined, undefined, teamId);
        break;
      }
      case 'customer.subscription.trial_will_end': {
        // Trial is ending in ~3 days: refresh period and surface a notice.
        const trialSub = event.data.object as any;
        if (trialSub.id) {
          this.subscriptions.updateSubscriptionStatus(
            trialSub.id,
            trialSub.status || 'trialing',
            trialSub.current_period_start ? new Date(trialSub.current_period_start * 1000).toISOString() : undefined,
            trialSub.current_period_end ? new Date(trialSub.current_period_end * 1000).toISOString() : undefined,
            teamId,
          );
        }
        console.warn(`[Billing] Trial ending soon for subscription ${trialSub.id}`);
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as any;
        if (invoice.subscription) {
          this.subscriptions.updateSubscriptionStatus(
            invoice.subscription as string,
            'active',
            invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : undefined,
            invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : undefined,
            teamId,
          );
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        if (invoice.subscription) {
          this.subscriptions.updateSubscriptionStatus(invoice.subscription as string, 'past_due', undefined, undefined, teamId);
        }
        break;
      }
      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break;
    }
  }

  getWebhookEvents(limit: number = 50, teamId: string | null = null): any[] {
    const scope = tenantFilter('team_id', teamId);
    const result = this.deps.db.exec(
      `SELECT id, provider, event_type, livemode, status, error, received_at, processed_at
       FROM webhook_events WHERE ${scope.clause} ORDER BY received_at DESC LIMIT ?`,
      [...scope.params, limit],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any) => ({
      id: row[0],
      provider: row[1],
      eventType: row[2],
      livemode: row[3] === 1,
      mode: row[3] === 1 ? 'live' : 'test',
      status: row[4],
      error: row[5],
      receivedAt: row[6],
      processedAt: row[7],
    }));
  }

  private handleGetSubscription(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const customerId = parsedUrl.searchParams.get('customerId');

    if (!customerId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'customerId is required' }));
      return;
    }

    const sub = this.subscriptions.getSubscriptionByCustomer(customerId, teamId);
    if (!sub) {
      res.end(JSON.stringify({ subscription: null }));
      return;
    }

    const limits = this.tierEnforcer.getLimits(sub.planTier);
    res.end(JSON.stringify({ subscription: { ...sub, limits } }));
  }

  private handleGetUsage(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const customerId = parsedUrl.searchParams.get('customerId');

    if (!customerId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'customerId is required' }));
      return;
    }

    const usage = this.usage.getCurrentUsage(customerId, teamId);
    const sub = this.subscriptions.getSubscriptionByCustomer(customerId, teamId);
    const limits = this.tierEnforcer.getLimits(sub?.planTier || null);

    res.end(JSON.stringify({
      usage,
      limits,
      remaining: {
        monitors: Math.max(0, limits.monitors - usage.monitors),
        reports: Math.max(0, limits.reports - usage.reports),
        storageMb: Math.max(0, limits.storageMb - usage.storageMb),
      },
    }));
  }

  private handleSummary(res: ServerResponse, teamId: string | null): void {
    const customerScope = tenantFilter('team_id', teamId);
    const subscriptionScope = tenantFilter('team_id', teamId);

    const customerResult = this.deps.db.exec(`SELECT COUNT(*) FROM customers WHERE ${customerScope.clause}`, customerScope.params);
    const totalCustomers = customerResult.length > 0 ? (customerResult[0].values[0][0] as number) : 0;

    const subscriptionsResult = this.deps.db.exec(`SELECT COUNT(*) FROM subscriptions WHERE ${subscriptionScope.clause}`, subscriptionScope.params);
    const totalSubscriptions = subscriptionsResult.length > 0 ? (subscriptionsResult[0].values[0][0] as number) : 0;

    const activeResult = this.deps.db.exec(`SELECT COUNT(*) FROM subscriptions WHERE ${subscriptionScope.clause} AND status = 'active'`, subscriptionScope.params);
    const activeSubscriptions = activeResult.length > 0 ? (activeResult[0].values[0][0] as number) : 0;

    const pastDueResult = this.deps.db.exec(`SELECT COUNT(*) FROM subscriptions WHERE ${subscriptionScope.clause} AND status = 'past_due'`, subscriptionScope.params);
    const pastDue = pastDueResult.length > 0 ? (pastDueResult[0].values[0][0] as number) : 0;

    const canceledResult = this.deps.db.exec(`SELECT COUNT(*) FROM subscriptions WHERE ${subscriptionScope.clause} AND status = 'canceled'`, subscriptionScope.params);
    const canceled = canceledResult.length > 0 ? (canceledResult[0].values[0][0] as number) : 0;

    const planResult = this.deps.db.exec(`SELECT plan_tier, COUNT(*) FROM subscriptions WHERE ${subscriptionScope.clause} AND status = 'active' GROUP BY plan_tier`, subscriptionScope.params);
    let mrr = 0;
    if (planResult.length > 0) {
      const planPrices: Record<string, number> = { basic: 99, advanced: 299, white_glove: 499 };
      for (const row of planResult[0].values) {
        mrr += (planPrices[row[0] as string] || 0) * (row[1] as number);
      }
    }

    res.end(JSON.stringify({
      customers: totalCustomers,
      subscriptions: totalSubscriptions,
      mrr,
      activeSubscriptions,
      pastDue,
      canceled,
    }));
  }

  private handleListSubscriptions(res: ServerResponse, teamId: string | null): void {
    const subscriptionScope = tenantFilter('s.team_id', teamId);
    const customerScope = tenantFilter('c.team_id', teamId);
    const result = this.deps.db.exec(
      `SELECT s.id, s.customer_id, c.name as customer_name, c.email as customer_email, s.plan_tier, s.status, s.current_period_start, s.current_period_end, s.created_at
       FROM subscriptions s LEFT JOIN customers c ON s.customer_id = c.id
       WHERE ${subscriptionScope.clause} AND ${customerScope.clause}
       ORDER BY s.created_at DESC`,
      [...subscriptionScope.params, ...customerScope.params],
    );
    const subscriptions = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      customerId: row[1],
      customerName: row[2],
      customerEmail: row[3],
      planTier: row[4],
      status: row[5],
      currentPeriodStart: row[6],
      currentPeriodEnd: row[7],
      createdAt: row[8],
    })) : [];
    res.end(JSON.stringify({ subscriptions }));
  }
}