import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';

describe('NOC-354 billing mount without a Stripe client', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;

  const ownerToken = () => createTestToken({ sub: TEST_CLERK_USER_ID });
  const memberToken = () => createTestToken({ sub: 'member-clerk-user' });

  before(async () => {
    db = await createDatabase();

    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner@example.com', 'Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['member-user', 'member-clerk-user', 'member@example.com', 'Member']);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'Primary Team', 'primary-team', TEST_LOCAL_USER_ID, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, TEST_LOCAL_USER_ID, 'owner']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, 'member-user', 'member']);

    server = startApiServer(db, { port: 0 });
    port = (server.address() as any).port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  it('answers the billing role with 200 for an owner when no Stripe client is configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/billing/access`, {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.role, 'owner');
  });

  it('answers the billing role with 200 for a member when no Stripe client is configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/billing/access`, {
      headers: { Authorization: `Bearer ${memberToken()}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json() as any;
    assert.strictEqual(body.role, 'member');
  });

  it('answers 401 for an unauthenticated billing role request', async () => {
    const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/billing/access`);
    assert.strictEqual(res.status, 401);
  });

  it('keeps the local billing routes working without a Stripe client', async () => {
    const plans = await fetch(`http://127.0.0.1:${port}/api/billing/plans`, {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    assert.strictEqual(plans.status, 200);
    const plansBody = await plans.json() as any;
    assert.ok(Array.isArray(plansBody.plans) && plansBody.plans.length > 0);

    const subscription = await fetch(`http://127.0.0.1:${port}/api/billing/subscription`, {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    assert.strictEqual(subscription.status, 200);
  });

  it('answers 503 and never 404 or 500 on the Stripe-dependent billing routes', async () => {
    const invoices = await fetch(`http://127.0.0.1:${port}/api/billing/invoices`, {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    assert.strictEqual(invoices.status, 503);

    const portal = await fetch(`http://127.0.0.1:${port}/api/billing/portal`, {
      headers: { Authorization: `Bearer ${ownerToken()}` },
    });
    assert.strictEqual(portal.status, 503);

    const checkout = await fetch(`http://127.0.0.1:${port}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier: 'basic' }),
    });
    assert.strictEqual(checkout.status, 503);

    const changePlan = await fetch(`http://127.0.0.1:${port}/api/billing/change-plan`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planTier: 'basic' }),
    });
    assert.strictEqual(changePlan.status, 503);
  });

  it('answers 503 on the Stripe webhook when no Stripe client is configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/billing/webhook`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken()}`,
        'Content-Type': 'application/json',
        'stripe-signature': 't=1,v1=unsupported',
      },
      body: JSON.stringify({ id: 'evt_test', type: 'checkout.session.completed' }),
    });
    assert.strictEqual(res.status, 503);
  });
});
