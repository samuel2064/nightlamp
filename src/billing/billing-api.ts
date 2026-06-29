import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { StripeClient, createCheckoutSession, createCustomerPortalSession, constructWebhookEvent } from './stripe-client';
import { SubscriptionModel, PlanTier, Subscription, PLAN_TIERS } from './subscription';
import { TierEnforcer } from './tier-enforcer';
import { UsageTracker } from './usage';

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

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/billing/create-checkout-session' && req.method === 'POST') {
      this.handleCreateCheckout(req, res);
      return true;
    }

    if (path === '/api/billing/portal' && req.method === 'GET') {
      this.handlePortalRedirect(req, res);
      return true;
    }

    if (path === '/api/billing/webhook' && req.method === 'POST') {
      this.handleWebhook(req, res);
      return true;
    }

    if (path === '/api/billing/subscription' && req.method === 'GET') {
      this.handleGetSubscription(req, res);
      return true;
    }

    if (path === '/api/billing/usage' && req.method === 'GET') {
      this.handleGetUsage(req, res);
      return true;
    }

    if (path === '/api/billing/plans' && req.method === 'GET') {
      this.handleListPlans(res);
      return true;
    }

    if (path === '/api/billing/customer' && req.method === 'POST') {
      this.handleCreateCustomer(req, res);
      return true;
    }

    if (path === '/api/billing/summary' && req.method === 'GET') {
      this.handleSummary(res);
      return true;
    }

    if (path === '/api/billing/subscriptions' && req.method === 'GET') {
      this.handleListSubscriptions(res);
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

  private handleCreateCustomer(req: IncomingMessage, res: ServerResponse): void {
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
        const customer = this.subscriptions.createCustomer(email, name);
        res.end(JSON.stringify({ customer }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleCreateCheckout(req: IncomingMessage, res: ServerResponse): void {
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

        const customer = this.subscriptions.getCustomer(customerId);
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

        const sub = this.subscriptions.createSubscription(customerId, planTier as PlanTier);

        const session = await createCheckoutSession(
          this.deps.stripeClient,
          customer.stripeCustomerId || undefined as any,
          planTier,
          successUrl,
          cancelUrl,
        );

        this.subscriptions.updateStripeSubscriptionId(sub.id, session.id, 'incomplete');

        res.end(JSON.stringify({ url: session.url, sessionId: session.id, subscriptionId: sub.id }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handlePortalRedirect(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const customerId = parsedUrl.searchParams.get('customerId');

    if (!customerId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'customerId is required' }));
      return;
    }

    const customer = this.subscriptions.getCustomer(customerId);
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

  private handleWebhook(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const signature = req.headers['stripe-signature'] as string;
        if (!signature) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing stripe-signature header' }));
          return;
        }

        const event = await constructWebhookEvent(
          this.deps.stripeClient,
          body,
          signature,
          this.deps.webhookSecret,
        );

        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as any;
            if (session.mode === 'subscription') {
              this.subscriptions.updateSubscriptionStatus(
                session.id,
                'active',
                new Date(session.created * 1000).toISOString(),
              );
            }
            break;
          }
          case 'customer.subscription.updated':
          case 'customer.subscription.created': {
            const sub = event.data.object as any;
            this.subscriptions.updateSubscriptionStatus(
              sub.id,
              sub.status,
              new Date(sub.current_period_start * 1000).toISOString(),
              new Date(sub.current_period_end * 1000).toISOString(),
            );
            break;
          }
          case 'customer.subscription.deleted': {
            const deletedSub = event.data.object as any;
            this.subscriptions.updateSubscriptionStatus(deletedSub.id, 'canceled');
            break;
          }
          case 'invoice.payment_failed': {
            const invoice = event.data.object as any;
            if (invoice.subscription) {
              this.subscriptions.updateSubscriptionStatus(invoice.subscription as string, 'past_due');
            }
            break;
          }
        }

        res.end(JSON.stringify({ received: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleGetSubscription(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const customerId = parsedUrl.searchParams.get('customerId');

    if (!customerId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'customerId is required' }));
      return;
    }

    const sub = this.subscriptions.getSubscriptionByCustomer(customerId);
    if (!sub) {
      res.end(JSON.stringify({ subscription: null }));
      return;
    }

    const limits = this.tierEnforcer.getLimits(sub.planTier);
    res.end(JSON.stringify({ subscription: { ...sub, limits } }));
  }

  private handleGetUsage(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const customerId = parsedUrl.searchParams.get('customerId');

    if (!customerId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'customerId is required' }));
      return;
    }

    const usage = this.usage.getCurrentUsage(customerId);
    const sub = this.subscriptions.getSubscriptionByCustomer(customerId);
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

  private handleSummary(res: ServerResponse): void {
    const customerResult = this.deps.db.exec('SELECT COUNT(*) FROM customers');
    const totalCustomers = customerResult.length > 0 ? (customerResult[0].values[0][0] as number) : 0;

    const subscriptionsResult = this.deps.db.exec('SELECT COUNT(*) FROM subscriptions');
    const totalSubscriptions = subscriptionsResult.length > 0 ? (subscriptionsResult[0].values[0][0] as number) : 0;

    const activeResult = this.deps.db.exec("SELECT COUNT(*) FROM subscriptions WHERE status = 'active'");
    const activeSubscriptions = activeResult.length > 0 ? (activeResult[0].values[0][0] as number) : 0;

    const pastDueResult = this.deps.db.exec("SELECT COUNT(*) FROM subscriptions WHERE status = 'past_due'");
    const pastDue = pastDueResult.length > 0 ? (pastDueResult[0].values[0][0] as number) : 0;

    const canceledResult = this.deps.db.exec("SELECT COUNT(*) FROM subscriptions WHERE status = 'canceled'");
    const canceled = canceledResult.length > 0 ? (canceledResult[0].values[0][0] as number) : 0;

    const planResult = this.deps.db.exec('SELECT plan_tier, COUNT(*) FROM subscriptions WHERE status = \'active\' GROUP BY plan_tier');
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

  private handleListSubscriptions(res: ServerResponse): void {
    const result = this.deps.db.exec(
      `SELECT s.id, s.customer_id, c.name as customer_name, c.email as customer_email, s.plan_tier, s.status, s.current_period_start, s.current_period_end, s.created_at
       FROM subscriptions s LEFT JOIN customers c ON s.customer_id = c.id
       ORDER BY s.created_at DESC`
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