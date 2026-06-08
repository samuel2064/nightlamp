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
}