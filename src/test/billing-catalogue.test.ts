import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { SubscriptionModel } from '../billing/subscription';
import { BillingApi } from '../billing/billing-api';
import { BILLING_CATALOGUE, BILLING_CURRENCY } from '../billing/catalogue';
import { buildObjectList, formatAmount, renderObjectList } from '../../scripts/stripe-catalogue-dry-run';

/**
 * NOC-313 acceptance coverage: webhook signature rejection, replay idempotency,
 * missing-customer-id refusal, and a dry-run output that carries no secret,
 * key, live price id, email or other real identifier beyond the object list.
 */
describe('Billing - NOC-313 catalogue dry run', () => {
  it('maps canonical pricing (Free/Pro/Team/Enterprise)', () => {
    const byTier = new Map(BILLING_CATALOGUE.map((p) => [p.tier, p]));
    expect([...byTier.keys()].sort()).to.deep.equal(['enterprise', 'free', 'pro', 'team']);

    const pro = byTier.get('pro')!;
    expect(pro.prices).to.have.lengthOf(2);
    expect(pro.prices[0].unitAmount).to.equal(9900); // 99.00 per month
    expect(pro.prices[1].unitAmount).to.equal(99000); // 990.00 per year (~17% off)

    const team = byTier.get('team')!;
    expect(team.prices).to.have.lengthOf(2);
    expect(team.prices[0].unitAmount).to.equal(29900); // 299.00 per month
    expect(team.prices[1].unitAmount).to.equal(299000); // 2990.00 per year (~17% off)

    expect(byTier.get('free')!.prices).to.have.lengthOf(0);
    expect(byTier.get('enterprise')!.prices).to.have.lengthOf(0);
  });

  it('formats amounts in minor units', () => {
    expect(formatAmount(9900, 'usd')).to.equal('99.00 USD');
    expect(formatAmount(299000, 'usd')).to.equal('2990.00 USD');
  });

  it('dry-run output lists products and prices and nothing live', () => {
    const output = renderObjectList();
    expect(output).to.include('product: Pro');
    expect(output).to.include('product: Team');
    expect(output).to.include('lookup_key=nightlamp_pro_monthly amount=99.00 USD interval=month interval_count=1');
    expect(output).to.include('lookup_key=nightlamp_team_yearly amount=2990.00 USD interval=year interval_count=1');
    // Hygiene: no secret, key, live stripe id, email or host.
    expect(output).to.not.match(/sk_[A-Za-z0-9]/);
    expect(output).to.not.match(/whsec_/);
    expect(output).to.not.match(/price_[A-Za-z0-9]{6}/);
    expect(output).to.not.match(/[^@\s]+@[^@\s]+\./);
    expect(output).to.not.include('onrender.com');
    expect(output).to.not.include('clerk');
  });

  it('object list carries lookup keys, not Stripe ids', () => {
    const products = buildObjectList();
    for (const product of products) {
      for (const price of product.prices) {
        expect(price.lookupKey).to.match(/^nightlamp_(pro|team)_(monthly|yearly)$/);
        expect(price.currency).to.equal('USD');
        expect(price.unitAmount % 100).to.equal(0);
      }
    }
  });

  it('documents the env vars a creation run would set', () => {
    const output = renderObjectList();
    expect(output).to.include('STRIPE_PRICE_PRO_MONTHLY');
    expect(output).to.include('STRIPE_PRICE_PRO_YEARLY');
    expect(output).to.include('STRIPE_PRICE_TEAM_MONTHLY');
    expect(output).to.include('STRIPE_PRICE_TEAM_YEARLY');
  });
});

describe('Billing - NOC-313 webhook signature rejection', () => {
  let db: Database;
  let api: BillingApi;

  beforeEach(async () => {
    db = await createDatabase();
    const mockStripe: any = {
      stripe: {
        webhooks: {
          constructEvent: (payload: string, signature: string, secret: string) => {
            if (signature !== 'good_sig') {
              throw new Error('No signatures found matching the expected signature for payload');
            }
            return JSON.parse(payload);
          },
        },
      },
      priceIds: { 'team:month': 'price_team_monthly' },
    };
    api = new BillingApi({ db, stripeClient: mockStripe, webhookSecret: 'whsec_test', baseUrl: 'http://localhost:3001' });
  });

  function postWebhook(payload: string, signature?: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve) => {
      let body = '';
      let code = 200;
      const req = {
        method: 'POST',
        url: '/api/billing/webhook',
        headers: signature ? { 'stripe-signature': signature } : {},
        on: (event: string, cb: Function) => {
          if (event === 'data') cb(payload);
          if (event === 'end') cb();
        },
      } as any;
      const res = {
        writeHead: (c: number) => { code = c; },
        end: (data: string) => resolve({ statusCode: code, body: data }),
      } as any;
      api.handle(req, res, null);
    });
  }

  it('rejects a webhook whose signature fails verification with 400', async () => {
    const payload = JSON.stringify({ id: 'evt_bad_sig', type: 'customer.subscription.created', data: { object: { id: 'sub_bad' } } });
    const res = await postWebhook(payload, 'tampered_signature');
    expect(res.statusCode).to.equal(400);
    expect(JSON.parse(res.body).error).to.include('signature');
    // No side effect: nothing recorded, nothing applied.
    expect(api.getWebhookEvents()).to.have.lengthOf(0);
  });

  it('rejects a webhook without a signature header with 400', async () => {
    const res = await postWebhook(JSON.stringify({ id: 'evt_no_sig', type: 'customer.subscription.created', data: { object: {} } }));
    expect(res.statusCode).to.equal(400);
    expect(JSON.parse(res.body).error).to.include('Missing stripe-signature');
  });
});

describe('Billing - NOC-313 replay idempotency', () => {
  let db: Database;
  let api: BillingApi;
  let subs: SubscriptionModel;

  beforeEach(async () => {
    db = await createDatabase();
    const mockStripe: any = {
      stripe: { webhooks: { constructEvent: (payload: string) => JSON.parse(payload) } },
      priceIds: { 'team:month': 'price_team_monthly' },
    };
    api = new BillingApi({ db, stripeClient: mockStripe, webhookSecret: 'whsec_test', baseUrl: 'http://localhost:3001' });
    subs = new SubscriptionModel(db);
  });

  function replay(payload: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve) => {
      let code = 200;
      const req = {
        method: 'POST',
        url: '/api/billing/webhook',
        headers: { 'stripe-signature': 'good_sig' },
        on: (event: string, cb: Function) => {
          if (event === 'data') cb(payload);
          if (event === 'end') cb();
        },
      } as any;
      const res = {
        writeHead: (c: number) => { code = c; },
        end: (data: string) => resolve({ statusCode: code, body: data }),
      } as any;
      api.handle(req, res, null);
    });
  }

  it('acknowledges a replayed event id without re-applying side effects', async () => {
    const cust = subs.createCustomer('replay@test.com');
    const sub = subs.createSubscription(cust.id, 'team_monthly');
    subs.updateStripeSubscriptionId(sub.id, 'sub_replay', 'incomplete');

    const payload = JSON.stringify({
      id: 'evt_replay_fixed',
      type: 'customer.subscription.created',
      data: { object: { id: 'sub_replay', status: 'active' } },
    });

    const first = await replay(payload);
    expect(first.statusCode).to.equal(200);
    expect(JSON.parse(first.body).duplicate).to.not.equal(true);

    // Change local state, then replay the same event: it must not be re-applied.
    subs.updateSubscriptionStatus('sub_replay', 'past_due');
    const second = await replay(payload);
    expect(second.statusCode).to.equal(200);
    expect(JSON.parse(second.body).duplicate).to.equal(true);

    expect(subs.getSubscription(sub.id)!.status).to.equal('past_due');
    expect(api.getWebhookEvents()).to.have.lengthOf(1);
  });
});

describe('Billing - NOC-313 missing customer refusal', () => {
  let db: Database;
  let api: BillingApi;
  let subs: SubscriptionModel;

  beforeEach(async () => {
    db = await createDatabase();
    const mockStripe: any = {
      stripe: {
        billingPortal: {
          sessions: {
            create: async (params: any) => ({ id: 'bps_test', url: `https://billing.stripe.com/session/${params.customer}` }),
          },
        },
      },
      priceIds: { 'team:month': 'price_team_monthly' },
    };
    api = new BillingApi({ db, stripeClient: mockStripe, webhookSecret: 'whsec_test', baseUrl: 'http://localhost:3001' });
    subs = new SubscriptionModel(db);
  });

  function portalRequest(): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve) => {
      let code = 200;
      const req = {
        method: 'GET',
        url: '/api/billing/portal',
        headers: {},
        on: (event: string, cb: Function) => { if (event === 'end') cb(); },
      } as any;
      const res = {
        writeHead: (c: number) => { code = c; },
        end: (data: string) => resolve({ statusCode: code, body: data }),
      } as any;
      api.handle(req, res, {
        userId: 'portal-user', email: 'portal@test.com', teamId: null, role: 'owner', token: 'verified-test-context',
      });
    });
  }

  it('refuses the portal session for a customer without a Stripe customer id (404)', async () => {
    subs.createCustomer('portal@test.com');
    const res = await portalRequest();
    expect(res.statusCode).to.equal(404);
    expect(JSON.parse(res.body).error).to.include('Customer not found or no Stripe customer ID');
    expect(res.body).to.not.include('billing.stripe.com');
  });

  it('refuses the portal session for an unknown customer (404)', async () => {
    // No customer row exists at all.
    const res = await portalRequest();
    expect(res.statusCode).to.equal(404);
  });

  it('creates a portal session for a customer with a Stripe customer id', async () => {
    const cust = subs.createCustomer('portal@test.com');
    subs.updateStripeCustomerId(cust.id, 'cus_test_portal');
    const res = await portalRequest();
    expect(res.statusCode).to.equal(200);
    expect(JSON.parse(res.body).url).to.equal('https://billing.stripe.com/session/cus_test_portal');
  });
});