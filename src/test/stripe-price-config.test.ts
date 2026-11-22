import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { SubscriptionModel } from '../billing/subscription';
import { createStripeClient, resolvePriceId, createCheckoutSession, PLAN_TIER_PRICE_ENV, LEGACY_TIER_MAP } from '../billing/stripe-client';
import { BillingApi } from '../billing/billing-api';
import { toCatalogueTier } from '../billing/subscription';

/**
 * NOC-318: the Stripe price configuration must fail closed. A missing price
 * id refuses with an error naming the missing variable; no Stripe request is
 * ever issued with a placeholder id, and no secret or value appears in any
 * error message.
 */
describe('Billing - price configuration fails closed (NOC-318)', () => {
  it('maps each catalogue tier+interval to the environment variable that must supply its price id', () => {
    expect(PLAN_TIER_PRICE_ENV).to.deep.equal({
      'free:month': 'STRIPE_PRICE_FREE_MONTHLY',
      'pro:month': 'STRIPE_PRICE_PRO_MONTHLY',
      'pro:year': 'STRIPE_PRICE_PRO_YEARLY',
      'team:month': 'STRIPE_PRICE_TEAM_MONTHLY',
      'team:year': 'STRIPE_PRICE_TEAM_YEARLY',
    });
  });

  it('maps legacy tier aliases to catalogue tier+interval', () => {
    expect(LEGACY_TIER_MAP).to.deep.equal({
      basic: 'pro:month',
      advanced: 'team:month',
      white_glove: 'white_glove',
    });
  });

  it('keeps only the price ids that were provided', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake', priceProMonthly: 'price_provided' });
    expect(Object.keys(client.priceIds)).to.deep.equal(['pro:month']);
    expect(client.priceIds['pro:month']).to.equal('price_provided');
  });

  it('treats whitespace-only values as missing', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake', priceProMonthly: '   ', priceProYearly: '' });
    expect(Object.keys(client.priceIds)).to.have.lengthOf(0);
  });

  it('resolves a configured price id for catalogue tier', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake', priceProMonthly: 'price_ok' });
    expect(resolvePriceId(client, 'pro:month')).to.equal('price_ok');
  });

  it('resolves a configured price id for legacy tier via mapping', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake', priceProMonthly: 'price_ok' });
    expect(resolvePriceId(client, 'basic')).to.equal('price_ok');
  });

  it('refuses with the missing variable named when the price id is absent', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake' });
    try {
      resolvePriceId(client, 'team:month');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.equal('Missing Stripe price configuration for plan tier "team:month": set STRIPE_PRICE_TEAM_MONTHLY');
      expect(err.message).to.not.include('price_');
      expect(err.message).to.not.match(/sk_|whsec_/);
    }
  });

  it('refuses with the missing variable named for legacy tier when unmapped', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake' });
    try {
      resolvePriceId(client, 'advanced');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.equal('Missing Stripe price configuration for plan tier "advanced": set STRIPE_PRICE_TEAM_MONTHLY');
      expect(err.message).to.not.include('price_');
      expect(err.message).to.not.match(/sk_|whsec_/);
    }
  });

  it('refuses an unknown plan tier without naming a price variable', () => {
    const client = createStripeClient({ secretKey: 'sk_test_fake' });
    try {
      resolvePriceId(client, 'platinum');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.equal('Unknown plan tier: platinum');
    }
  });

  it('issues no checkout request when the price id is missing', async () => {
    let createCalls = 0;
    const mockStripe: any = {
      checkout: {
        sessions: {
          create: async (params: any) => {
            createCalls += 1;
            return { id: 'cs_test', url: 'https://checkout.stripe.com/test', ...params };
          },
        },
      },
    };
    const client: any = { stripe: mockStripe, priceIds: {} };

    try {
      await createCheckoutSession(client, 'cus_123', 'pro:month', 'https://example.com/success', 'https://example.com/cancel');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.include('Missing Stripe price configuration');
      expect(err.message).to.include('STRIPE_PRICE_PRO_MONTHLY');
    }
    expect(createCalls).to.equal(0);
  });

  it('issues no checkout request when the legacy tier price id is missing', async () => {
    let createCalls = 0;
    const mockStripe: any = {
      checkout: {
        sessions: {
          create: async (params: any) => {
            createCalls += 1;
            return { id: 'cs_test', url: 'https://checkout.stripe.com/test', ...params };
          },
        },
      },
    };
    const client: any = { stripe: mockStripe, priceIds: {} };

    try {
      await createCheckoutSession(client, 'cus_123', 'basic', 'https://example.com/success', 'https://example.com/cancel');
      expect.fail('should have thrown');
    } catch (err: any) {
      expect(err.message).to.include('Missing Stripe price configuration');
      expect(err.message).to.include('STRIPE_PRICE_PRO_MONTHLY');
    }
    expect(createCalls).to.equal(0);
  });
});

describe('Billing - API fails closed on missing price configuration (NOC-318)', () => {
  let db: Database;

  function buildApi(stripeOverrides: Record<string, any>, priceIds: Record<string, string>): { api: BillingApi; updateCalls: () => number; createCalls: () => number } {
    let updateCalls = 0;
    let createCalls = 0;
    const mockStripe: any = {
      stripe: {
        checkout: { sessions: { create: async (params: any) => { createCalls += 1; return { id: 'cs_test', url: 'https://checkout.stripe.com/test', ...params }; } } },
        billingPortal: { sessions: { create: async (params: any) => ({ id: 'bps_test', url: 'https://billing.stripe.com/test', ...params }) } },
        subscriptions: {
          retrieve: async () => ({ id: 'sub_remote', customer: 'cus_stripe', items: { data: [{ id: 'si_own' }] } }),
          update: async (params: any) => { updateCalls += 1; return params; },
        },
        webhooks: { constructEvent: (payload: string) => JSON.parse(payload) },
        ...stripeOverrides,
      },
      priceIds,
    };
    const api = new BillingApi({ db, stripeClient: mockStripe, webhookSecret: 'whsec_test', baseUrl: 'http://localhost:3001' });
    return { api, updateCalls: () => updateCalls, createCalls: () => createCalls };
  }

  function request(api: BillingApi, method: string, url: string, body?: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve) => {
      let code = 200;
      let responseBody = '';
      const req = {
        method,
        url,
        headers: {},
        on: (event: string, cb: Function) => {
          if (event === 'data' && body) cb(body);
          if (event === 'end') cb();
        },
      } as any;
      const res = {
        writeHead: (c: number) => { code = c; },
        end: (data: string) => { responseBody = data; resolve({ statusCode: code, body: responseBody }); },
      } as any;
      api.handle(req, res, {
        userId: 'billing-user', email: 'billing@test.com', teamId: null, role: 'owner', token: 'verified-test-context',
      });
    });
  }

  beforeEach(async () => {
    db = await createDatabase();
  });

  it('POST create-checkout-session refuses a missing price id with 400 naming the variable, no Stripe call', async () => {
    const { api, createCalls } = buildApi({}, { 'pro:month': 'price_pro_monthly' }); // pro:year is unconfigured
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('billing@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_stripe');

    const res = await request(api, 'POST', '/api/billing/create-checkout-session', JSON.stringify({ planTier: 'pro_yearly' }));
    expect(res.statusCode).to.equal(400);
    const data = JSON.parse(res.body);
    expect(data.error).to.equal('Missing Stripe price configuration for plan tier "pro_yearly": set STRIPE_PRICE_PRO_YEARLY');
    expect(createCalls()).to.equal(0);
  });

  it('POST create-checkout-session refuses a missing price id for legacy tier with 400 naming the variable, no Stripe call', async () => {
    const { api, createCalls } = buildApi({}, { 'team:month': 'price_team_monthly' }); // pro:month is unconfigured
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('billing@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_stripe');

    const res = await request(api, 'POST', '/api/billing/create-checkout-session', JSON.stringify({ planTier: 'basic' }));
    expect(res.statusCode).to.equal(400);
    const data = JSON.parse(res.body);
    expect(data.error).to.equal('Missing Stripe price configuration for plan tier "basic": set STRIPE_PRICE_PRO_MONTHLY');
    expect(createCalls()).to.equal(0);
  });

  it('POST change-plan refuses a missing price id with 400 naming the variable, no Stripe update', async () => {
    const { api, updateCalls } = buildApi({}, { 'pro:month': 'price_pro_monthly' }); // pro:year is unconfigured
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('billing@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_stripe');
    const sub = subs.createSubscription(cust.id, 'pro_monthly');
    subs.updateStripeSubscriptionId(sub.id, 'sub_active', 'active');

    const res = await request(api, 'POST', '/api/billing/change-plan', JSON.stringify({ planTier: 'pro_yearly' }));
    expect(res.statusCode).to.equal(400);
    expect(JSON.parse(res.body).error).to.include('set STRIPE_PRICE_PRO_YEARLY');
    expect(updateCalls()).to.equal(0);
  });

  it('POST change-plan refuses a missing price id for legacy tier with 400 naming the variable, no Stripe update', async () => {
    const { api, updateCalls } = buildApi({}, { 'team:month': 'price_team_monthly' }); // pro:month is unconfigured
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('billing@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_stripe');
    const sub = subs.createSubscription(cust.id, 'pro_monthly');
    subs.updateStripeSubscriptionId(sub.id, 'sub_active', 'active');

    const res = await request(api, 'POST', '/api/billing/change-plan', JSON.stringify({ planTier: 'basic' }));
    expect(res.statusCode).to.equal(400);
    expect(JSON.parse(res.body).error).to.include('set STRIPE_PRICE_PRO_MONTHLY');
    expect(updateCalls()).to.equal(0);
  });

  it('POST change-plan still succeeds when the price id is configured', async () => {
    const { api, updateCalls } = buildApi({}, { 'pro:month': 'price_pro_monthly', 'pro:year': 'price_pro_yearly' });
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('billing@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_stripe');
    const sub = subs.createSubscription(cust.id, 'pro_monthly');
    subs.updateStripeSubscriptionId(sub.id, 'sub_active', 'active');

    const res = await request(api, 'POST', '/api/billing/change-plan', JSON.stringify({ planTier: 'pro_yearly' }));
    expect(res.statusCode).to.equal(200);
    expect(updateCalls()).to.equal(1);
    expect(subs.getSubscription(sub.id)!.planTier).to.equal('pro_yearly');
  });

  it('POST change-plan still succeeds for legacy tier when the price id is configured', async () => {
    const { api, updateCalls } = buildApi({}, { 'pro:month': 'price_pro_monthly', 'team:month': 'price_team_monthly' });
    const subs = new SubscriptionModel(db);
    const cust = subs.createCustomer('billing@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_stripe');
    const sub = subs.createSubscription(cust.id, 'pro_monthly');
    subs.updateStripeSubscriptionId(sub.id, 'sub_active', 'active');

    const res = await request(api, 'POST', '/api/billing/change-plan', JSON.stringify({ planTier: 'advanced' }));
    expect(res.statusCode).to.equal(200);
    expect(updateCalls()).to.equal(1);
    expect(subs.getSubscription(sub.id)!.planTier).to.equal('advanced');
  });
});