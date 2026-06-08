import { expect } from 'chai';
import { Database } from 'sql.js';
import { Server, IncomingMessage } from 'http';
import { createDatabase } from '../db/schema';
import { SubscriptionModel, PLAN_TIERS } from '../billing/subscription';
import { TierEnforcer } from '../billing/tier-enforcer';
import { UsageTracker } from '../billing/usage';
import { createStripeClient, createCheckoutSession, createCustomerPortalSession, constructWebhookEvent } from '../billing/stripe-client';
import { BillingApi } from '../billing/billing-api';

describe('Billing - Subscription Model', () => {
  let db: Database;
  let subs: SubscriptionModel;

  beforeEach(async () => {
    db = await createDatabase();
    subs = new SubscriptionModel(db);
  });

  it('creates a customer', () => {
    const c = subs.createCustomer('test@example.com', 'Test User');
    expect(c.id).to.be.a('string');
    expect(c.email).to.equal('test@example.com');
    expect(c.name).to.equal('Test User');
  });

  it('gets customer by id', () => {
    const c = subs.createCustomer('a@b.com', 'Alice');
    const found = subs.getCustomer(c.id);
    expect(found).to.not.be.null;
    expect(found!.email).to.equal('a@b.com');
  });

  it('gets customer by stripe id', () => {
    const c = subs.createCustomer('b@c.com');
    subs.updateStripeCustomerId(c.id, 'cus_stripe123');
    const found = subs.getCustomerByStripeId('cus_stripe123');
    expect(found).to.not.be.null;
    expect(found!.id).to.equal(c.id);
  });

  it('creates a subscription', () => {
    const c = subs.createCustomer('test@test.com');
    const sub = subs.createSubscription(c.id, 'advanced');
    expect(sub.id).to.be.a('string');
    expect(sub.planTier).to.equal('advanced');
    expect(sub.status).to.equal('incomplete');
  });

  it('gets subscription by customer', () => {
    const c = subs.createCustomer('x@y.com');
    const sub = subs.createSubscription(c.id, 'basic');
    const found = subs.getSubscriptionByCustomer(c.id);
    expect(found).to.not.be.null;
    expect(found!.id).to.equal(sub.id);
  });

  it('updates subscription status', () => {
    const c = subs.createCustomer('u@v.com');
    const sub = subs.createSubscription(c.id, 'white_glove');
    subs.updateStripeSubscriptionId(sub.id, 'sub_stripe123', 'active');
    subs.updateSubscriptionStatus('sub_stripe123', 'active', '2026-01-01', '2026-02-01');
    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('active');
    expect(updated!.stripeSubscriptionId).to.equal('sub_stripe123');
  });

  it('cancels subscription', () => {
    const c = subs.createCustomer('cancel@test.com');
    const sub = subs.createSubscription(c.id, 'basic');
    subs.cancelSubscription(sub.id, false);
    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('canceled');
  });
});

describe('Billing - Plan Tiers', () => {
  it('defines three pricing tiers', () => {
    expect(PLAN_TIERS.basic.price).to.equal(99);
    expect(PLAN_TIERS.advanced.price).to.equal(299);
    expect(PLAN_TIERS.white_glove.price).to.equal(499);
  });

  it('basic has 5 monitors, 100 reports, 100MB', () => {
    expect(PLAN_TIERS.basic.monitors).to.equal(5);
    expect(PLAN_TIERS.basic.reports).to.equal(100);
    expect(PLAN_TIERS.basic.storageMb).to.equal(100);
  });

  it('advanced has 20 monitors, 500 reports, 500MB', () => {
    expect(PLAN_TIERS.advanced.monitors).to.equal(20);
    expect(PLAN_TIERS.advanced.reports).to.equal(500);
    expect(PLAN_TIERS.advanced.storageMb).to.equal(500);
  });

  it('white_glove has 100 monitors, 2000 reports, 2000MB', () => {
    expect(PLAN_TIERS.white_glove.monitors).to.equal(100);
    expect(PLAN_TIERS.white_glove.reports).to.equal(2000);
    expect(PLAN_TIERS.white_glove.storageMb).to.equal(2000);
  });
});

describe('Billing - Tier Enforcer', () => {
  const enforcer = new TierEnforcer();

  it('returns zero limits for null tier', () => {
    const limits = enforcer.getLimits(null);
    expect(limits.monitors).to.equal(0);
    expect(limits.reports).to.equal(0);
    expect(limits.storageMb).to.equal(0);
  });

  it('returns correct limits per tier', () => {
    const basic = enforcer.getLimits('basic');
    expect(basic.monitors).to.equal(5);

    const adv = enforcer.getLimits('advanced');
    expect(adv.monitors).to.equal(20);
  });

  it('checks limit - allowed when under', () => {
    const sub = { planTier: 'basic' as const, status: 'active' } as any;
    const check = enforcer.checkLimit(sub, 'monitors', 2);
    expect(check.allowed).to.be.true;
    expect(check.limit).to.equal(5);
  });

  it('checks limit - not allowed at limit', () => {
    const sub = { planTier: 'basic' as const, status: 'active' } as any;
    const check = enforcer.checkLimit(sub, 'monitors', 5);
    expect(check.allowed).to.be.false;
  });

  it('isSubscriptionActive returns true for active/trialing', () => {
    expect(enforcer.isSubscriptionActive({ status: 'active' } as any)).to.be.true;
    expect(enforcer.isSubscriptionActive({ status: 'trialing' } as any)).to.be.true;
    expect(enforcer.isSubscriptionActive({ status: 'past_due' } as any)).to.be.false;
    expect(enforcer.isSubscriptionActive(null)).to.be.false;
  });
});

describe('Billing - Usage Tracker', () => {
  let db: Database;
  let usage: UsageTracker;

  beforeEach(async () => {
    db = await createDatabase();
    usage = new UsageTracker(db);
  });

  it('records and retrieves usage', () => {
    usage.recordUsage('cust-1', 'monitors', 3);
    usage.recordUsage('cust-1', 'reports', 10);
    usage.recordUsage('cust-1', 'storage_mb', 50);

    const current = usage.getCurrentUsage('cust-1');
    expect(current.monitors).to.equal(3);
    expect(current.reports).to.equal(10);
    expect(current.storageMb).to.equal(50);
  });

  it('returns zero for customer with no usage', () => {
    const current = usage.getCurrentUsage('nonexistent');
    expect(current.monitors).to.equal(0);
    expect(current.reports).to.equal(0);
    expect(current.storageMb).to.equal(0);
  });

  it('resets usage', () => {
    usage.recordUsage('cust-2', 'monitors', 10);
    usage.resetUsage('cust-2');
    const current = usage.getCurrentUsage('cust-2');
    expect(current.monitors).to.equal(0);
  });

  it('aggregates multiple records', () => {
    usage.recordUsage('cust-3', 'monitors', 2);
    usage.recordUsage('cust-3', 'monitors', 3);
    const current = usage.getCurrentUsage('cust-3');
    expect(current.monitors).to.equal(5);
  });
});

describe('Billing - Stripe Client', () => {
  it('creates a stripe client with default price IDs', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake' });
    expect(client.stripe).to.exist;
    expect(client.priceIds.basic).to.equal('price_basic');
    expect(client.priceIds.advanced).to.equal('price_advanced');
    expect(client.priceIds.white_glove).to.equal('price_white_glove');
  });

  it('creates a stripe client with custom price IDs', () => {
    const client = createStripeClient({
      secretKey: 'sk_test_fake',
      priceBasic: 'price_basic_custom',
      priceAdvanced: 'price_adv_custom',
      priceWhiteGlove: 'price_wg_custom',
    });
    expect(client.priceIds.basic).to.equal('price_basic_custom');
    expect(client.priceIds.advanced).to.equal('price_adv_custom');
    expect(client.priceIds.white_glove).to.equal('price_wg_custom');
  });

  it('creates a checkout session', async () => {
    const mockStripe = { checkout: { sessions: { create: async (params: any) => ({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test', ...params }) } } };
    const client: any = { stripe: mockStripe, priceIds: { basic: 'price_basic' } };

    const session = await createCheckoutSession(client, 'cus_123', 'basic', 'https://example.com/success', 'https://example.com/cancel');
    expect(session.id).to.equal('cs_test_123');
    expect(session.url).to.include('checkout.stripe.com');
    expect(session.mode).to.equal('subscription');
    expect(session.line_items[0].price).to.equal('price_basic');
  });

  it('throws on unknown plan tier for checkout session', async () => {
    const client: any = { stripe: null, priceIds: { basic: 'price_basic' } };
    try {
      await createCheckoutSession(client, 'cus_123', 'nonexistent_tier', 'url', 'url');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.include('Unknown plan tier');
    }
  });

  it('creates a customer portal session', async () => {
    const mockStripe = { billingPortal: { sessions: { create: async (params: any) => ({ id: 'bps_test_123', url: 'https://billing.stripe.com/test', ...params }) } } };
    const client: any = { stripe: mockStripe, priceIds: {} };

    const session = await createCustomerPortalSession(client, 'cus_123', 'https://example.com/return');
    expect(session.id).to.equal('bps_test_123');
    expect(session.url).to.include('billing.stripe.com');
    expect(session.customer).to.equal('cus_123');
  });

  it('constructs a webhook event', async () => {
    const payload = JSON.stringify({ id: 'evt_test_123', type: 'customer.subscription.created', data: { object: { id: 'sub_123' } } });
    const signature = 'test_signature';
    const secret = 'whsec_test';

    const mockConstructEvent = (p: string, s: string, sec: string) => JSON.parse(p);
    const mockStripe: any = { webhooks: { constructEvent: mockConstructEvent } };
    const client: any = { stripe: mockStripe, priceIds: {} };

    const event = await constructWebhookEvent(client, payload, signature, secret);
    expect(event.id).to.equal('evt_test_123');
    expect(event.type).to.equal('customer.subscription.created');
  });
});

describe('Billing - BillingApi', () => {
  let db: Database;
  let api: BillingApi;

  beforeEach(async () => {
    db = await createDatabase();
    const mockStripe: any = {
      stripe: {
        checkout: {
          sessions: {
            create: async (params: any) => ({
              id: 'cs_test_' + Date.now(),
              url: 'https://checkout.stripe.com/pay/cs_test',
              ...params,
            }),
          },
        },
        billingPortal: {
          sessions: {
            create: async (params: any) => ({
              id: 'bps_test_' + Date.now(),
              url: 'https://billing.stripe.com/pay/bps_test',
              ...params,
            }),
          },
        },
        webhooks: {
          constructEvent: (payload: string, signature: string, secret: string) => JSON.parse(payload),
        },
      },
      priceIds: { basic: 'price_basic_monthly', advanced: 'price_advanced_monthly', white_glove: 'price_white_glove_monthly' },
    };

    api = new BillingApi({
      db,
      stripeClient: mockStripe,
      webhookSecret: 'whsec_test',
      baseUrl: 'http://localhost:3001',
    });

    const subs = new SubscriptionModel(db);
    subs.createCustomer('test@nightlamp.dev', 'Test User');
    const cust = subs.getCustomerByStripeId(null as any) || subs.getCustomer(subs.createCustomer('cust_for_test', 'Test').id);
  });

  it('GET /api/billing/plans returns all plans', async () => {
    const res = await handleRequest(api, 'GET', '/api/billing/plans');
    const data = JSON.parse(res.body);
    expect(data.plans).to.have.lengthOf(3);
    expect(data.plans[0].id).to.equal('basic');
    expect(data.plans[1].id).to.equal('advanced');
    expect(data.plans[2].id).to.equal('white_glove');
  });

  it('POST /api/billing/customer creates a customer', async () => {
    const res = await handleRequest(api, 'POST', '/api/billing/customer', JSON.stringify({ email: 'new@test.com', name: 'New User' }));
    const data = JSON.parse(res.body);
    expect(data.customer.email).to.equal('new@test.com');
    expect(data.customer.name).to.equal('New User');
    expect(data.customer.id).to.be.a('string');
  });

  it('POST /api/billing/customer requires email', async () => {
    const res = await handleRequest(api, 'POST', '/api/billing/customer', JSON.stringify({ name: 'No Email' }));
    expect(res.statusCode).to.equal(400);
    const data = JSON.parse(res.body);
    expect(data.error).to.include('email is required');
  });

  it('POST /api/billing/create-checkout-session creates checkout', async () => {
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('checkout@test.com');
    const res = await handleRequest(api, 'POST', '/api/billing/create-checkout-session', JSON.stringify({ customerId: cust.id, planTier: 'advanced' }));
    const data = JSON.parse(res.body);
    expect(data.url).to.be.a('string');
    expect(data.sessionId).to.be.a('string');
    expect(data.subscriptionId).to.be.a('string');
  });

  it('POST /api/billing/create-checkout-session rejects missing fields', async () => {
    const res = await handleRequest(api, 'POST', '/api/billing/create-checkout-session', JSON.stringify({}));
    expect(res.statusCode).to.equal(400);
  });

  it('POST /api/billing/create-checkout-session rejects invalid tier', async () => {
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('bad-tier@test.com');
    const res = await handleRequest(api, 'POST', '/api/billing/create-checkout-session', JSON.stringify({ customerId: cust.id, planTier: 'platinum' }));
    expect(res.statusCode).to.equal(400);
    const data = JSON.parse(res.body);
    expect(data.error).to.include('Invalid plan tier');
  });

  it('POST /api/billing/create-checkout-session rejects unknown customer', async () => {
    const res = await handleRequest(api, 'POST', '/api/billing/create-checkout-session', JSON.stringify({ customerId: 'nonexistent', planTier: 'basic' }));
    expect(res.statusCode).to.equal(404);
  });

  it('GET /api/billing/subscription returns subscription with limits', async () => {
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('sub-check@test.com');
    subs.createSubscription(cust.id, 'basic');
    const res = await handleRequest(api, 'GET', `/api/billing/subscription?customerId=${cust.id}`);
    const data = JSON.parse(res.body);
    expect(data.subscription).to.not.be.null;
    expect(data.subscription.planTier).to.equal('basic');
    expect(data.subscription.limits.monitors).to.equal(5);
  });

  it('GET /api/billing/subscription returns null for no subscription', async () => {
    const res = await handleRequest(api, 'GET', '/api/billing/subscription?customerId=nonexistent');
    const data = JSON.parse(res.body);
    expect(data.subscription).to.be.null;
  });

  it('GET /api/billing/subscription requires customerId', async () => {
    const res = await handleRequest(api, 'GET', '/api/billing/subscription');
    expect(res.statusCode).to.equal(400);
  });

  it('GET /api/billing/usage returns usage with remaining', async () => {
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('usage-check@test.com');
    subs.createSubscription(cust.id, 'advanced');
    const usage = new UsageTracker(db);
    usage.recordUsage(cust.id, 'monitors', 3);
    usage.recordUsage(cust.id, 'reports', 10);

    const res = await handleRequest(api, 'GET', `/api/billing/usage?customerId=${cust.id}`);
    const data = JSON.parse(res.body);
    expect(data.usage.monitors).to.equal(3);
    expect(data.usage.reports).to.equal(10);
    expect(data.limits.monitors).to.equal(20);
    expect(data.remaining.monitors).to.equal(17);
  });

  it('GET /api/billing/usage requires customerId', async () => {
    const res = await handleRequest(api, 'GET', '/api/billing/usage');
    expect(res.statusCode).to.equal(400);
  });

  it('GET /api/billing/portal requires customerId', async () => {
    const res = await handleRequest(api, 'GET', '/api/billing/portal');
    expect(res.statusCode).to.equal(400);
  });

  it('GET /api/billing/portal returns 404 for customer without stripe ID', async () => {
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('no-stripe@test.com');
    const res = await handleRequest(api, 'GET', `/api/billing/portal?customerId=${cust.id}`);
    expect(res.statusCode).to.equal(404);
  });

  it('handles unknown route', () => {
    const req = { method: 'GET', url: '/api/billing/unknown', headers: {} } as IncomingMessage;
    const res = { writeHead: () => {}, end: () => {} } as any;
    const handled = api.handle(req, res);
    expect(handled).to.be.false;
  });
});

describe('Billing - Webhook Processing', () => {
  let db: Database;
  let api: BillingApi;
  let subs: SubscriptionModel;

  beforeEach(async () => {
    db = await createDatabase();
    const mockStripe: any = {
      stripe: {
        checkout: { sessions: { create: async (p: any) => ({ id: 'cs_test_' + Date.now(), url: 'https://checkout.stripe.com/test', ...p }) } },
        billingPortal: { sessions: { create: async (p: any) => ({ id: 'bps_test_' + Date.now(), url: 'https://billing.stripe.com/test', ...p }) } },
        webhooks: { constructEvent: (payload: string, sig: string, secret: string) => JSON.parse(payload) },
      },
      priceIds: { basic: 'price_basic' },
    };

    api = new BillingApi({ db, stripeClient: mockStripe, webhookSecret: 'whsec_test', baseUrl: 'http://localhost:3001' });
    subs = new SubscriptionModel(db);
  });

  function buildWebhookEvent(eventType: string, dataObject: any): string {
    return JSON.stringify({ id: 'evt_' + Date.now(), type: eventType, data: { object: dataObject } });
  }

  it('processes checkout.session.completed - marks subscription active', async () => {
    const cust = subs.createCustomer('checkout-complete@test.com');
    const sub = subs.createSubscription(cust.id, 'basic');

    subs.updateStripeSubscriptionId(sub.id, 'cs_test_completed', 'incomplete');

    const payload = buildWebhookEvent('checkout.session.completed', {
      id: 'cs_test_completed',
      mode: 'subscription',
      created: Math.floor(Date.now() / 1000),
    });

    const res = await handleRequest(api, 'POST', '/api/billing/webhook', payload, { 'stripe-signature': 'test_sig' });
    expect(res.statusCode).to.equal(200);

    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('active');
  });

  it('processes customer.subscription.created - updates status and periods', async () => {
    const cust = subs.createCustomer('sub-created@test.com');
    const sub = subs.createSubscription(cust.id, 'advanced');
    const now = Math.floor(Date.now() / 1000);
    const in30 = now + 2592000;

    subs.updateStripeSubscriptionId(sub.id, 'sub_created_123', 'incomplete');

    const payload = buildWebhookEvent('customer.subscription.created', {
      id: 'sub_created_123',
      status: 'active',
      current_period_start: now,
      current_period_end: in30,
    });

    await handleRequest(api, 'POST', '/api/billing/webhook', payload, { 'stripe-signature': 'test_sig' });

    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('active');
    expect(updated!.currentPeriodStart).to.exist;
    expect(updated!.currentPeriodEnd).to.exist;
  });

  it('processes customer.subscription.updated - updates status', async () => {
    const cust = subs.createCustomer('sub-updated@test.com');
    const sub = subs.createSubscription(cust.id, 'basic');
    subs.updateStripeSubscriptionId(sub.id, 'sub_updated_123', 'active');
    subs.updateSubscriptionStatus('sub_updated_123', 'active');

    const now = Math.floor(Date.now() / 1000);
    const payload = buildWebhookEvent('customer.subscription.updated', {
      id: 'sub_updated_123',
      status: 'past_due',
      current_period_start: now,
      current_period_end: now + 2592000,
    });

    await handleRequest(api, 'POST', '/api/billing/webhook', payload, { 'stripe-signature': 'test_sig' });

    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('past_due');
  });

  it('processes customer.subscription.deleted - marks canceled', async () => {
    const cust = subs.createCustomer('sub-deleted@test.com');
    const sub = subs.createSubscription(cust.id, 'white_glove');
    subs.updateStripeSubscriptionId(sub.id, 'sub_deleted_123', 'active');
    subs.updateSubscriptionStatus('sub_deleted_123', 'active');

    const payload = buildWebhookEvent('customer.subscription.deleted', { id: 'sub_deleted_123' });
    await handleRequest(api, 'POST', '/api/billing/webhook', payload, { 'stripe-signature': 'test_sig' });

    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('canceled');
  });

  it('processes invoice.payment_failed - marks past_due', async () => {
    const cust = subs.createCustomer('payment-fail@test.com');
    const sub = subs.createSubscription(cust.id, 'basic');
    subs.updateStripeSubscriptionId(sub.id, 'sub_payment_fail', 'active');
    subs.updateSubscriptionStatus('sub_payment_fail', 'active');

    const payload = buildWebhookEvent('invoice.payment_failed', { subscription: 'sub_payment_fail' });
    await handleRequest(api, 'POST', '/api/billing/webhook', payload, { 'stripe-signature': 'test_sig' });

    const updated = subs.getSubscription(sub.id);
    expect(updated!.status).to.equal('past_due');
  });

  it('rejects webhook without stripe-signature header', async () => {
    const res = await handleRequest(api, 'POST', '/api/billing/webhook', '{}', {});
    expect(res.statusCode).to.equal(400);
    const data = JSON.parse(res.body);
    expect(data.error).to.include('Missing stripe-signature');
  });

  it('returns received:true for valid webhook', async () => {
    const cust = subs.createCustomer('valid-webhook@test.com');
    subs.createSubscription(cust.id, 'basic');

    const payload = buildWebhookEvent('customer.subscription.created', {
      id: 'sub_valid_webhook',
      status: 'active',
      current_period_start: Math.floor(Date.now() / 1000),
      current_period_end: Math.floor(Date.now() / 1000) + 2592000,
    });

    const res = await handleRequest(api, 'POST', '/api/billing/webhook', payload, { 'stripe-signature': 'test_sig' });
    const data = JSON.parse(res.body);
    expect(data.received).to.be.true;
  });
});

function handleRequest(api: BillingApi, method: string, url: string, body?: string, headers?: Record<string, string>): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve) => {
    let responseBody = '';
    let responseCode = 200;

    const req = {
      method,
      url,
      headers: headers || {},
      on: (event: string, cb: Function) => {
        if (event === 'data' && body) cb(body);
        if (event === 'end') cb();
      },
    } as any;

    const res = {
      writeHead: (code: number) => { responseCode = code; },
      end: (data: string) => {
        responseBody = data;
        resolve({ statusCode: responseCode, body: responseBody });
      },
    } as any;

    api.handle(req, res);
  });
}