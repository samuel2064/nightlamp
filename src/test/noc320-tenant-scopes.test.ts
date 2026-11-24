import * as http from 'http';
import * as crypto from 'crypto';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { setDb, initEngine } from '../remediation/engine';
import { TEST_JWT_SECRET } from './setup';

// NOC-320 pinned regressions. The suite signs its own tokens with its own
// HMAC code (the shared test secret value only, never a harness-minted
// token) and probes through the server over node http: no authentication is
// injected into any request, and every probe is trusted only after the
// tokenless request is proved to answer 401.

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function mintToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { iat: now, exp: now + 3600, ...claims };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', TEST_JWT_SECRET).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

interface ProbeResult {
  status: number;
  body: any;
}

function probe(port: number, method: string, path: string, token?: string, payload?: unknown): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body).toString();
    }
    if (token) {
      headers['authorization'] = `Bearer ${token}`;
    }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed: any = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function membershipCount(db: Database, teamId: string, userId: string): number {
  const rows = db.exec('SELECT id FROM memberships WHERE team_id = ? AND user_id = ?', [teamId, userId]);
  return rows.length > 0 ? rows[0].values.length : 0;
}

describe('NOC-320 residual tenant scopes and onboarding owner binding', () => {
  let db: Database;
  let server: http.Server;
  let port: number;

  const userA = 'noc320-user-a';
  const userA2 = 'noc320-user-a2';
  const userB = 'noc320-user-b';
  const userC = 'noc320-user-c';
  const userO = 'noc320-user-o';

  let teamA: string;
  let teamB: string;
  let customerA: string;
  let subscriptionA: string;
  let legacyCustomer: string;
  let legacySubscription: string;
  let webhookEventA: string;
  let legacyEvent: string;
  let incidentA: string;
  let incidentB: string;
  let legacyIncident: string;

  const tokenA = mintToken({ sub: 'noc320-clerk-a', email: 'a@example.com' });
  const tokenA2 = mintToken({ sub: 'noc320-clerk-a2', email: 'a2@example.com' });
  const tokenB = mintToken({ sub: 'noc320-clerk-b', email: 'b@example.com' });
  const tokenC = mintToken({ sub: 'noc320-clerk-c', email: 'c@example.com' });
  const tokenO = mintToken({ sub: 'noc320-clerk-o', email: 'o@example.com' });

  before(async () => {
    db = await createDatabase();
    setDb(db);
    initEngine();

    const seedUser = (id: string, clerkId: string, email: string, name: string) => {
      db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [id, clerkId, email, name]);
    };
    seedUser(userA, 'noc320-clerk-a', 'a@example.com', 'User A');
    seedUser(userA2, 'noc320-clerk-a2', 'a2@example.com', 'User A2');
    seedUser(userB, 'noc320-clerk-b', 'b@example.com', 'User B');
    seedUser(userC, 'noc320-clerk-c', 'c@example.com', 'User C');
    seedUser(userO, 'noc320-clerk-o', 'o@example.com', 'User O');

    teamA = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamA, 'Team A', 'noc320-team-a', userA, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamA, userA, 'owner']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamA, userA2, 'member']);

    teamB = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamB, 'Team B', 'noc320-team-b', userB, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamB, userB, 'owner']);

    customerA = uuidv4();
    db.run('INSERT INTO customers (id, stripe_customer_id, email, name, team_id) VALUES (?, ?, ?, ?, ?)',
      [customerA, 'cus_A', 'a@example.com', 'Customer A', teamA]);
    subscriptionA = uuidv4();
    db.run(`INSERT INTO subscriptions (id, customer_id, stripe_subscription_id, plan_tier, status, team_id)
            VALUES (?, ?, ?, 'basic', 'active', ?)`,
      [subscriptionA, customerA, 'sub_A', teamA]);
    for (const [metric, value] of [['monitors', 3], ['reports', 5], ['storage_mb', 10]] as Array<[string, number]>) {
      db.run('INSERT INTO usage_records (id, customer_id, metric, value, team_id) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), customerA, metric, value, teamA]);
    }

    // Legacy personal rows in the unscoped bucket, owned by a different email
    // than every signed-in probe identity.
    legacyCustomer = uuidv4();
    db.run('INSERT INTO customers (id, stripe_customer_id, email, name, team_id) VALUES (?, ?, ?, ?, ?)',
      [legacyCustomer, 'cus_legacy', 'legacy@example.com', 'Legacy Customer', null]);
    legacySubscription = uuidv4();
    db.run(`INSERT INTO subscriptions (id, customer_id, stripe_subscription_id, plan_tier, status, team_id)
            VALUES (?, ?, ?, 'basic', 'active', ?)`,
      [legacySubscription, legacyCustomer, 'sub_legacy', null]);
    db.run('INSERT INTO usage_records (id, customer_id, metric, value, team_id) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), legacyCustomer, 'monitors', 99, null]);

    webhookEventA = uuidv4();
    db.run(`INSERT INTO webhook_events (id, provider, event_type, status, payload, team_id)
            VALUES (?, 'stripe', 'invoice.payment_succeeded', 'processed', '{}', ?)`,
      [webhookEventA, teamA]);
    legacyEvent = uuidv4();
    db.run(`INSERT INTO webhook_events (id, provider, event_type, status, payload, team_id)
            VALUES (?, 'stripe', 'invoice.payment_succeeded', 'processed', '{}', ?)`,
      [legacyEvent, null]);

    const seedIncident = (id: string, teamId: string | null, title: string) => {
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, detected_at, team_id)
              VALUES (?, ?, 'downtime', 'critical', ?, datetime('now'), ?)`,
        [id, `chk-${id}`, title, teamId]);
    };
    incidentA = uuidv4();
    incidentB = uuidv4();
    legacyIncident = uuidv4();
    seedIncident(incidentA, teamA, 'Team A incident');
    seedIncident(incidentB, teamB, 'Team B incident');
    seedIncident(legacyIncident, null, 'Legacy incident');

    server = startApiServer(db, {
      port: 0,
      stripeClient: {
        stripe: {
          checkout: {
            sessions: { create: async (params: any) => ({ id: 'cs_noc320', url: 'https://checkout.stripe.com/noc320', ...params }) },
          },
          billingPortal: {
            sessions: { create: async () => ({ id: 'bps_noc320', url: 'https://billing.stripe.com/noc320' }) },
          },
          invoices: { list: async () => ({ data: [], has_more: false }) },
          subscriptions: {
            retrieve: async (id: string) => ({
              id,
              customer: id === 'sub_A' ? 'cus_A' : 'cus_foreign',
              items: { data: [{ id: 'si_noc320' }] },
            }),
            update: async (id: string, params: any) => ({ id, ...params }),
          },
          webhooks: { constructEvent: (payload: string) => JSON.parse(payload) },
        },
        priceIds: { basic: 'price_basic', advanced: 'price_advanced', white_glove: 'price_white_glove' },
      } as any,
    });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  describe('probe harness', () => {
    it('answers 401 on a protected route without a token', async () => {
      const res = await probe(port, 'GET', '/api/reports/team-summary');
      assert.strictEqual(res.status, 401);
    });

    it('answers 401 on a protected billing route without a token', async () => {
      const res = await probe(port, 'GET', '/api/billing/subscription');
      assert.strictEqual(res.status, 401);
    });
  });

  describe('item A: onboarding owner membership', () => {
    it('writes the owner membership row for the authenticated principal', async () => {
      const start = await probe(port, 'POST', '/api/onboarding/start', tokenO, { userId: userO });
      assert.strictEqual(start.status, 200);
      const sessionId = start.body.sessionId as string;
      assert.ok(sessionId);

      for (const step of ['monitor-selection', 'alert-config', 'team-invite']) {
        const stepped = await probe(port, 'POST', `/api/onboarding/${sessionId}/step`, tokenO, { step, data: {} });
        assert.strictEqual(stepped.status, 200, `${step} failed: ${JSON.stringify(stepped.body)}`);
      }

      const complete = await probe(port, 'POST', `/api/onboarding/${sessionId}/complete`, tokenO, {});
      assert.strictEqual(complete.status, 200, JSON.stringify(complete.body));
      const teamId = complete.body.teamId as string;
      assert.ok(teamId);

      const memberships = db.exec('SELECT team_id, user_id, role FROM memberships WHERE user_id = ?', [userO]);
      assert.strictEqual(memberships.length > 0 ? memberships[0].values.length : 0, 1);
      assert.deepStrictEqual(memberships[0].values[0], [teamId, userO, 'owner']);

      const teams = db.exec('SELECT id FROM teams WHERE id = ?', [teamId]);
      assert.strictEqual(teams.length > 0 ? teams[0].values.length : 0, 1);
      const workspaces = db.exec('SELECT id FROM team_workspaces WHERE team_id = ?', [teamId]);
      assert.strictEqual(workspaces.length > 0 ? workspaces[0].values.length : 0, 1);
    });

    it('lets the principal read the team it just created as that principal', async () => {
      const teams = db.exec('SELECT id FROM teams WHERE owner_id = ?', [userO]);
      const ownedTeamId = teams[0].values[0][0] as string;

      const summary = await probe(port, 'GET', '/api/reports/team-summary', tokenO);
      assert.strictEqual(summary.status, 200, JSON.stringify(summary.body));
      assert.strictEqual(summary.body.teams.total, 1);
      assert.strictEqual(summary.body.team.totalMembers, 1);
      assert.ok(summary.body.monitoring.totalMonitors >= 0);

      const rows = db.exec('SELECT id FROM teams WHERE id = ?', [ownedTeamId]);
      assert.strictEqual(rows.length > 0 ? rows[0].values.length : 0, 1);
    });

    it('is idempotent: a repeated membership write leaves exactly one row', () => {
      const teams = db.exec('SELECT id FROM teams WHERE owner_id = ?', [userO]);
      const ownedTeamId = teams[0].values[0][0] as string;

      db.run(
        `INSERT OR IGNORE INTO memberships (id, team_id, user_id, role, invited_at) VALUES (?, ?, ?, 'owner', datetime('now'))`,
        [uuidv4(), ownedTeamId, userO],
      );
      assert.strictEqual(membershipCount(db, ownedTeamId, userO), 1);

      // A second repeated write still cannot add a row or raise.
      db.run(
        `INSERT OR IGNORE INTO memberships (id, team_id, user_id, role, invited_at) VALUES (?, ?, ?, 'owner', datetime('now'))`,
        [uuidv4(), ownedTeamId, userO],
      );
      assert.strictEqual(membershipCount(db, ownedTeamId, userO), 1);
    });

    it('refuses a signed-in user with no membership on team-scoped routes', async () => {
      const teams = db.exec('SELECT id FROM memberships WHERE user_id = ?', [userC]);
      assert.strictEqual(teams.length, 0);

      const reports = await probe(port, 'GET', '/api/reports/team-summary', tokenC);
      assert.strictEqual(reports.status, 403);

      const events = await probe(port, 'GET', '/api/billing/webhook-events', tokenC);
      assert.strictEqual(events.status, 403);
    });
  });

  describe('item B: residual fail-open scopes', () => {
    it('billing webhook events refuse a teamless caller and scope rows per tenant', async () => {
      const teamless = await probe(port, 'GET', '/api/billing/webhook-events', tokenC);
      assert.strictEqual(teamless.status, 403);

      const asA = await probe(port, 'GET', '/api/billing/webhook-events', tokenA);
      assert.strictEqual(asA.status, 200);
      const idsA = (asA.body.events as Array<{ id: string }>).map((event) => event.id);
      assert.deepStrictEqual(idsA, [webhookEventA]);

      const asB = await probe(port, 'GET', '/api/billing/webhook-events', tokenB);
      assert.strictEqual(asB.status, 200);
      assert.deepStrictEqual(asB.body.events, []);
    });

    it('billing subscription binds the personal bucket to the authenticated principal', async () => {
      const asC = await probe(port, 'GET', '/api/billing/subscription', tokenC);
      assert.strictEqual(asC.status, 200);
      assert.strictEqual(asC.body.subscription, null);

      const asA = await probe(port, 'GET', '/api/billing/subscription', tokenA);
      assert.strictEqual(asA.status, 200);
      assert.strictEqual(asA.body.subscription.id, subscriptionA);
      assert.strictEqual(asA.body.subscription.planTier, 'basic');

      const asB = await probe(port, 'GET', '/api/billing/subscription', tokenB);
      assert.strictEqual(asB.status, 200);
      assert.strictEqual(asB.body.subscription, null);
    });

    it('billing usage binds to the resolved customer and never leaks another bucket', async () => {
      const asC = await probe(port, 'GET', '/api/billing/usage', tokenC);
      assert.strictEqual(asC.status, 200);
      assert.deepStrictEqual(asC.body.usage, { monitors: 0, reports: 0, storageMb: 0 });

      const asA = await probe(port, 'GET', '/api/billing/usage', tokenA);
      assert.strictEqual(asA.status, 200);
      assert.deepStrictEqual(asA.body.usage, { monitors: 3, reports: 5, storageMb: 10 });

      const asB = await probe(port, 'GET', '/api/billing/usage', tokenB);
      assert.strictEqual(asB.status, 200);
      assert.deepStrictEqual(asB.body.usage, { monitors: 0, reports: 0, storageMb: 0 });
    });

    it('billing subscription mutation requires the elevated role and stays in the tenant', async () => {
      const asC = await probe(port, 'POST', '/api/billing/change-plan', tokenC, { planTier: 'advanced' });
      assert.strictEqual(asC.status, 403);

      const asB = await probe(port, 'POST', '/api/billing/change-plan', tokenB, { planTier: 'advanced' });
      assert.strictEqual(asB.status, 404);

      const asA = await probe(port, 'POST', '/api/billing/change-plan', tokenA, { planTier: 'advanced' });
      assert.strictEqual(asA.status, 200, JSON.stringify(asA.body));
      assert.strictEqual(asA.body.subscription.planTier, 'advanced');

      const row = db.exec('SELECT plan_tier FROM subscriptions WHERE id = ?', [subscriptionA]);
      assert.strictEqual(row[0].values[0][0], 'advanced');
      const legacyRow = db.exec('SELECT plan_tier FROM subscriptions WHERE id = ?', [legacySubscription]);
      assert.strictEqual(legacyRow[0].values[0][0], 'basic');
    });

    it('reports summary scopes counts and incident data to the caller team', async () => {
      const asA = await probe(port, 'GET', '/api/reports/team-summary', tokenA);
      assert.strictEqual(asA.status, 200);
      assert.strictEqual(asA.body.teams.total, 1);
      assert.strictEqual(asA.body.team.totalMembers, 2);
      assert.strictEqual(asA.body.incidents.totalLast30d, 1);
      assert.strictEqual(asA.body.incidents.criticalLast30d, 1);

      const asB = await probe(port, 'GET', '/api/reports/team-summary', tokenB);
      assert.strictEqual(asB.status, 200);
      assert.strictEqual(asB.body.teams.total, 1);
      assert.strictEqual(asB.body.team.totalMembers, 1);
      assert.strictEqual(asB.body.incidents.totalLast30d, 1);
      assert.strictEqual(asB.body.incidents.byType[0].failureType, 'downtime');
      assert.strictEqual(asB.body.incidents.byType[0].count, 1);

      const asA2 = await probe(port, 'GET', '/api/reports/team-summary', tokenA2);
      assert.strictEqual(asA2.status, 200);
      assert.strictEqual(asA2.body.team.totalMembers, 2);
      assert.strictEqual(asA2.body.incidents.totalLast30d, 1);
    });
  });
});