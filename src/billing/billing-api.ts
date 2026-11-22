import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuid } from 'uuid';
import { StripeClient, createCheckoutSession, createCustomerPortalSession, constructWebhookEvent, resolvePriceId } from './stripe-client';
import { SubscriptionModel, PlanTier, Subscription, PLAN_TIERS, getPlanDisplayName, getPlanMonthlyPrice, getPlanInterval, getPlanPrice, toCatalogueTier } from './subscription';
import { TierEnforcer } from './tier-enforcer';
import { UsageTracker } from './usage';
import { AuthContext, requireRole } from '../api/auth';
import { tenantFilter, tenantOwnedFilter } from '../api/tenant';

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
    const routes = ['create-checkout-session', 'portal', 'webhook', 'webhook-events', 'subscription',
      'usage', 'plans', 'customer', 'summary', 'subscriptions', 'invoices', 'change-plan', 'cancel'];
    if (!routes.some(route => path === `/api/billing/${route}`)) return false;

    // Webhooks have their own signature verification. Every customer-facing
    // operation requires the server's verified auth context, even when called directly.
    if (path !== '/api/billing/webhook') {
      if (!auth) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return true;
      }
      if (['customerId', 'teamId', 'orgId', 'stripeCustomerId', 'subscriptionId'].some(key => parsedUrl.searchParams.has(key))) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Billing identity is resolved from authentication' }));
        return true;
      }
      if (req.method !== 'GET' || path === '/api/billing/portal') {
        try {
          requireRole(auth, ['owner', 'admin']);
        } catch {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'This operation requires elevated permissions' }));
          return true;
        }
      }
    }

    if (path === '/api/billing/invoices' && req.method === 'GET') {
      this.handleInvoices(req, res, auth!);
      return true;
    }
    if ((path === '/api/billing/change-plan' || path === '/api/billing/cancel') && req.method === 'POST') {
      this.handleSubscriptionMutation(req, res, auth!, path.endsWith('/cancel'));
      return true;
    }

    if (path === '/api/billing/create-checkout-session' && req.method === 'POST') {
      this.handleCreateCheckout(req, res, auth!);
      return true;
    }

    if (path === '/api/billing/portal' && req.method === 'GET') {
      this.handlePortalRedirect(req, res, auth!);
      return true;
    }

    if (path === '/api/billing/webhook' && req.method === 'POST') {
      this.handleWebhook(req, res, teamId);
      return true;
    }

    if (path === '/api/billing/webhook-events' && req.method === 'GET') {
      // The audit table has no owner column, so the unscoped bucket is shared
      // by every personal identity: a caller with no membership is refused
      // before the query instead of reading every legacy row (NOC-319).
      if (teamId === null) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'A team membership is required to access this resource', code: 'FORBIDDEN' }));
        return true;
      }
      const limit = parseInt(parsedUrl.searchParams.get('limit') || '50', 10);
      res.end(JSON.stringify({ events: this.getWebhookEvents(limit, teamId) }));
      return true;
    }
    if (path === '/api/billing/subscription' && req.method === 'GET') {
      this.handleGetSubscription(req, res, auth!);
      return true;
    }

    if (path === '/api/billing/usage' && req.method === 'GET') {
      this.handleGetUsage(req, res, auth!);
      return true;
    }

    if (path === '/api/billing/plans' && req.method === 'GET') {
      this.handleListPlans(res);
      return true;
    }

    if (path === '/api/billing/customer' && req.method === 'POST') {
      this.handleCreateCustomer(req, res, auth!);
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

  private rejectIdentity(input: Record<string, unknown>, res: ServerResponse): boolean {
    if (['customerId', 'teamId', 'orgId', 'stripeCustomerId', 'subscriptionId'].some(key => Object.hasOwn(input, key))) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Billing identity is resolved from authentication' }));
      return true;
    }
    return false;
  }

  private resolveCustomer(auth: AuthContext) {
    const scope = tenantFilter('team_id', auth.teamId);
    // Legacy personal customers have no team; bind those to the verified local
    // user's email rather than allowing one personal user to select another.
    const personal = auth.teamId === null ? ' AND email = ?' : '';
    const rows = this.deps.db.exec(
      `SELECT id FROM customers WHERE ${scope.clause}${personal} ORDER BY created_at DESC, id DESC LIMIT 1`,
      [...scope.params, ...(auth.teamId === null ? [auth.email] : [])],
    );
    return rows.length ? this.subscriptions.getCustomer(rows[0].values[0][0] as string, auth.teamId) : null;
  }

  private async handleInvoices(req: IncomingMessage, res: ServerResponse, auth: AuthContext): Promise<void> {
    const stripe = this.deps.stripeClient;
    try {
      const customer = this.resolveCustomer(auth);
      if (!customer?.stripeCustomerId) {
        res.end(JSON.stringify({ invoices: [], hasMore: false }));
        return;
      }
      const result = await stripe.stripe.invoices.list({ customer: customer.stripeCustomerId, limit: 50 });
      const invoices = result.data.map((invoice: any) => ({
        id: invoice.id, number: invoice.number, status: invoice.status, currency: invoice.currency,
        amountDue: invoice.amount_due, amountPaid: invoice.amount_paid, created: invoice.created,
        invoiceUrl: invoice.hosted_invoice_url, pdfUrl: invoice.invoice_pdf,
      }));
      res.end(JSON.stringify({ invoices, hasMore: result.has_more }));
    } catch {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Unable to load billing history' }));
    }
  }

  private handleSubscriptionMutation(req: IncomingMessage, res: ServerResponse, auth: AuthContext, cancel: boolean): void {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const stripe = this.deps.stripeClient;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(body || '{}');
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON object' }));
        return;
      }
      if (this.rejectIdentity(input, res)) return;
      let priceId: string | null = null;
      // white_glove is withdrawn from sale (CEO ratified on NOC-327); existing
      // subscriptions are honoured but new signups and plan changes to white_glove
      // are not allowed.
      // Legacy aliases basic and advanced are honoured (map to pro_monthly and team_monthly).
      // free has a $0 Stripe price and is purchasable via checkout.
      // enterprise has no Stripe price and is not purchasable.
      const allowedPlanTiers: PlanTier[] = ['free', 'pro_monthly', 'pro_yearly', 'team_monthly', 'team_yearly', 'basic', 'advanced'];
      if (!cancel && (typeof input.planTier !== 'string' || !allowedPlanTiers.includes(input.planTier as PlanTier))) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid plan tier' }));
        return;
      }
      if (!cancel) {
        // Fail closed before any Stripe call: a missing price id refuses with
        // the missing variable named instead of reaching Stripe (NOC-318).
        try {
          priceId = resolvePriceId(stripe, input.planTier as PlanTier);
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
      }
      try {
        const customer = this.resolveCustomer(auth);
        const sub = customer ? this.subscriptions.getSubscriptionByCustomer(customer.id, auth.teamId) : null;
        if (!customer?.stripeCustomerId || !sub?.stripeSubscriptionId || !['active', 'trialing', 'past_due'].includes(sub.status)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No current subscription' }));
          return;
        }

        const stripeSubscription = stripe.stripe;
        const remote = await stripeSubscription.subscriptions.retrieve(sub.stripeSubscriptionId);
        const remoteCustomer = typeof remote.customer === 'string' ? remote.customer : remote.customer?.id;
        if (remoteCustomer !== customer.stripeCustomerId) throw new Error('Subscription customer mismatch');
        if (cancel) {
          await stripeSubscription.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
          const scope = tenantFilter('team_id', auth.teamId);
          this.deps.db.run(`UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = datetime('now') WHERE id = ? AND ${scope.clause}`, [sub.id, ...scope.params]);
        } else {
          const planTier = input.planTier as PlanTier;
          const price = priceId ?? resolvePriceId(stripe, planTier);
          if (remote.items?.data?.length !== 1) throw new Error('Unsupported subscription configuration');
          // Leave proration_behavior unspecified: retain Stripe's configured/default
          // policy rather than accepting a client-controlled billing policy.
          await stripeSubscription.subscriptions.update(sub.stripeSubscriptionId, {
            items: [{ id: remote.items.data[0].id, price }], payment_behavior: 'error_if_incomplete',
          });
          const scope = tenantFilter('team_id', auth.teamId);
          this.deps.db.run(`UPDATE subscriptions SET plan_tier = ?, updated_at = datetime('now') WHERE id = ? AND ${scope.clause}`, [planTier, sub.id, ...scope.params]);
        }
        this.handleGetSubscription(req, res, auth);
      } catch {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Unable to update subscription' }));
      }
    });
  }

  private handleCreateCustomer(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        if (this.rejectIdentity(input, res)) return;
        const { email, name } = input;
        if (!email) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'email is required' }));
          return;
        }
        const customer = this.resolveCustomer(auth) || this.subscriptions.createCustomer(
          auth.teamId === null ? auth.email : email, name, auth.teamId,
        );
        res.end(JSON.stringify({ customer }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleCreateCheckout(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    const teamId = auth.teamId;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const stripe = this.deps.stripeClient;
      try {
        const input = JSON.parse(body);
        const { planTier } = input;
        if (this.rejectIdentity(input, res)) return;
        if (!planTier) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'planTier is required' }));
          return;
        }

        const customer = this.resolveCustomer(auth);
        if (!customer?.stripeCustomerId) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Customer not found' }));
          return;
        }

        // Legacy aliases basic and advanced are honoured (map to pro_monthly and team_monthly).
        // free has a $0 Stripe price and is purchasable via checkout.
        // enterprise has no Stripe price and is not purchasable.
        // white_glove is withdrawn from sale (CEO ratified on NOC-327); existing
        // subscriptions are honoured but new signups to white_glove are not allowed.
        const allowedPlanTiers: PlanTier[] = ['free', 'pro_monthly', 'pro_yearly', 'team_monthly', 'team_yearly', 'basic', 'advanced'];
        if (!allowedPlanTiers.includes(planTier as PlanTier)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Invalid plan tier: ${planTier}` }));
          return;
        }

        // Fail closed before any Stripe call: an unconfigured price id refuses
        // with the missing variable named instead of reaching Stripe (NOC-318).
        try {
          resolvePriceId(stripe, planTier as PlanTier);
        } catch (err: any) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        const successUrl = `${this.deps.baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`;
        const cancelUrl = `${this.deps.baseUrl}/billing/cancel`;

        const session = await createCheckoutSession(
          stripe,
          customer.stripeCustomerId,
          planTier as PlanTier,
          successUrl,
          cancelUrl,
        );

        const sub = this.subscriptions.createSubscription(customer.id, planTier as PlanTier, teamId);
        this.subscriptions.updateStripeSubscriptionId(sub.id, session.id, 'incomplete', teamId);

        res.end(JSON.stringify({ url: session.url, sessionId: session.id, subscriptionId: sub.id }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handlePortalRedirect(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    const stripe = this.deps.stripeClient;
    const customer = this.resolveCustomer(auth);
    if (!customer || !customer.stripeCustomerId) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Customer not found or no Stripe customer ID' }));
      return;
    }

    createCustomerPortalSession(
      stripe,
      customer.stripeCustomerId,
      `${this.deps.baseUrl}/dashboard/billing`,
    ).then((session) => {
      res.end(JSON.stringify({ url: session.url }));
    }).catch((err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
  }

  /**
   * Resolve the owning team for a Stripe event from the local customer or
   * subscription rows it references. Stripe callback payloads carry no
   * Nightlamp session, so the attribution has to come from the stored rows.
   * Returns null when nothing local references the event, which keeps the
   * legacy (pre-team) rows workable while owned rows stay attributed.
   */
  private resolveWebhookTeam(event: any): string | null {
    const object = event?.data?.object;
    if (!object) return null;

    const stripeCustomerId = typeof object.customer === 'string' ? object.customer : object.customer?.id;
    const stripeSubscriptionId = event?.type?.startsWith?.('customer.subscription')
      ? object.id
      : object.subscription;

    const lookups: Array<[string, string]> = [];
    if (typeof stripeSubscriptionId === 'string' && stripeSubscriptionId) {
      lookups.push(['SELECT team_id FROM subscriptions WHERE stripe_subscription_id = ?', stripeSubscriptionId]);
    }
    if (typeof stripeCustomerId === 'string' && stripeCustomerId) {
      lookups.push(['SELECT team_id FROM customers WHERE stripe_customer_id = ?', stripeCustomerId]);
    }

    for (const [sql, param] of lookups) {
      const rows = this.deps.db.exec(sql, [param]);
      if (rows.length > 0 && rows[0].values.length > 0) {
        const value = rows[0].values[0][0];
        if (typeof value === 'string' && value) return value;
      }
    }
    return null;
  }

  private handleWebhook(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      const stripe = this.deps.stripeClient;
      const signature = req.headers['stripe-signature'] as string;
      if (!signature) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing stripe-signature header' }));
        return;
      }

      let event: any;
      try {
        event = await constructWebhookEvent(
          stripe,
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

      // The webhook is authenticated by the Stripe signature, not by a session,
      // so the row is attributed to the team that owns the referenced customer
      // or subscription. Without that binding the audit row would land in the
      // unscoped bucket that every personal identity shares (NOC-319).
      const resolvedTeamId = this.resolveWebhookTeam(event) ?? teamId;

      // Idempotency: a previously processed event id is acknowledged without
      // re-running side effects (Stripe retries deliveries at-least-once).
      const eventScope = tenantFilter('team_id', resolvedTeamId);
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
          [eventId, event.type, livemode ? 1 : 0, body, resolvedTeamId],
        );
      }

      try {
        this.applyWebhookEvent(event, resolvedTeamId);
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

  private handleGetSubscription(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    const customer = this.resolveCustomer(auth);
    const sub = customer ? this.subscriptions.getSubscriptionByCustomer(customer.id, auth.teamId) : null;
    if (!sub) {
      res.end(JSON.stringify({ subscription: null }));
      return;
    }

    const limits = this.tierEnforcer.getLimits(sub.planTier);
    const interval = getPlanInterval(sub.planTier);
    const price = getPlanPrice(sub.planTier);
    res.end(JSON.stringify({ subscription: { ...sub, limits, price, currency: 'usd', billingPeriod: interval, nextBillingDate: sub.cancelAtPeriodEnd ? null : sub.currentPeriodEnd } }));
  }

  private handleGetUsage(req: IncomingMessage, res: ServerResponse, auth: AuthContext): void {
    const customer = this.resolveCustomer(auth);
    const usage = customer ? this.usage.getCurrentUsage(customer.id, auth.teamId) : { monitors: 0, reports: 0, storageMb: 0 };
    const sub = customer ? this.subscriptions.getSubscriptionByCustomer(customer.id, auth.teamId) : null;
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

  private handleListPlans(res: ServerResponse): void {
    // Return self-serve purchasable plans only (catalogue tiers with Stripe prices).
    // free has a $0 Stripe price and is purchasable via checkout.
    // enterprise has no Stripe price and is not purchasable via checkout.
    // Legacy aliases basic and advanced are honoured (map to pro_monthly and team_monthly).
    // white_glove is withdrawn (CEO ratified NOC-327).
    const selfServeTiers: PlanTier[] = ['free', 'pro_monthly', 'pro_yearly', 'team_monthly', 'team_yearly'];
    const plans = selfServeTiers.map(tier => {
      const config = PLAN_TIERS[tier];
      return {
        id: tier,
        name: config.name,
        price: config.price,
        interval: config.interval,
        monitors: config.monitors,
        reports: config.reports,
        storageMb: config.storageMb,
      };
    });
    res.end(JSON.stringify({ plans }));
  }

  private handleSummary(res: ServerResponse, teamId: string | null): void {
    // Billing aggregates cover rows that always belong to a tenant, so a caller
    // without a membership reads nothing rather than the unscoped bucket.
    const customerScope = tenantOwnedFilter('team_id', teamId);
    const subscriptionScope = tenantOwnedFilter('team_id', teamId);

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
      for (const row of planResult[0].values) {
        mrr += getPlanMonthlyPrice(row[0] as PlanTier) * (row[1] as number);
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
    const subscriptionScope = tenantOwnedFilter('s.team_id', teamId);
    const customerScope = tenantOwnedFilter('c.team_id', teamId);
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
