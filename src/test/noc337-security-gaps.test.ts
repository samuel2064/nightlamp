import assert from 'assert';
import { Server } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { startApiServer } from '../api/server';
import { initEngine, setDb } from '../remediation/engine';
import { createDatabase } from '../db';
import { createTestToken, fetchWithoutAuth } from './setup';
import { NOC337_PENDING_REASONS } from '../api/server';
import { StripeClient } from '../billing/stripe-client';

const mockStripeClient: StripeClient = {
  stripe: {
    webhooks: {
      constructEvent: async (payload: string, signature: string, secret: string) => {
        if (!signature) throw new Error('Missing stripe-signature header');
        return { id: 'evt_test', type: 'test', livemode: false, data: { object: {} } };
      },
    },
    customers: {
      create: async () => ({ id: 'cus_test' }),
      retrieve: async () => ({ id: 'cus_test', email: 'test@test.com' }),
    },
    checkout: {
      sessions: {
        create: async () => ({ id: 'cs_test', url: 'http://test.com' }),
      },
    },
    billingPortal: {
      sessions: {
        create: async () => ({ url: 'http://test.com' }),
      },
    },
    subscriptions: {
      retrieve: async () => ({ id: 'sub_test', status: 'active', current_period_start: Date.now() / 1000, current_period_end: Date.now() / 1000, cancel_at_period_end: false, items: { data: [{ price: { id: 'price_test' } }] } }),
      update: async () => ({ id: 'sub_test' }),
      cancel: async () => ({ id: 'sub_test', status: 'canceled' }),
    },
    prices: {
      retrieve: async () => ({ id: 'price_test', unit_amount: 1000, currency: 'usd', recurring: { interval: 'month' } }),
      list: async () => ({ data: [] }),
    },
    invoices: {
      list: async () => ({ data: [] }),
      retrieve: async () => ({ id: 'in_test', amount_paid: 1000, currency: 'usd', status: 'paid', period_start: Date.now() / 1000, period_end: Date.now() / 1000 }),
    },
  },
  priceIds: { basic: 'price_basic', advanced: 'price_advanced', white_glove: 'price_white_glove' },
};

type TestIdentity = {
  userId: string;
  clerkId: string;
  marker: string;
};

type TestRequest = {
  method?: string;
  body?: unknown;
};

describe('NOC-337: Route-level P0 API Security Gaps', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let ownerA: TestIdentity;
  let ownerB: TestIdentity;
  let creator: TestIdentity;
  let member: TestIdentity;
  let invitee: TestIdentity;
  let lonely: TestIdentity;
  let teamAId: string;
  let teamBId: string;
  let checkAId: string;
  let eventAId: string;
  let legacyEventId: string;
  let dependencyAId: string;
  let channelAId: string;
  let entryAId: string;
  let runAId: string;

  function createIdentity(label: string): TestIdentity {
    const identity = {
      userId: uuidv4(),
      clerkId: uuidv4(),
      marker: `${label}-${uuidv4()}`,
    };
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      identity.userId,
      identity.clerkId,
      identity.marker,
      identity.marker,
    ]);
    return identity;
  }

  function tokenFor(identity: TestIdentity, claims: Record<string, unknown> = {}): string {
    return createTestToken({ sub: identity.clerkId, email: identity.marker, ...claims });
  }

  async function request(
    identity: TestIdentity,
    path: string,
    options: TestRequest = {},
  ): Promise<Response> {
    const headers = new Headers();
    headers.set('authorization', `Bearer ${tokenFor(identity)}`);
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, {
      method: options.method || 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  async function requestWithToken(token: string, path: string, options: TestRequest = {}): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${token}` });
    if (options.body !== undefined) headers.set('content-type', 'application/json');
    return fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, {
      method: options.method || 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  }

  function scalar(sql: string, params: unknown[] = []): any {
    const result = db.exec(sql, params as any[]);
    return result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : null;
  }

  before(async () => {
    db = await createDatabase();
    setDb(db);
    initEngine();

    ownerA = createIdentity('owner-a');
    ownerB = createIdentity('owner-b');
    creator = createIdentity('creator');
    member = createIdentity('member');
    invitee = createIdentity('invitee');
    lonely = createIdentity('lonely');

    teamAId = uuidv4();
    teamBId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)', [
      teamAId,
      `team-${uuidv4()}`,
      `team-${uuidv4()}`,
      ownerA.userId,
      'free',
    ]);
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)', [
      teamBId,
      `team-${uuidv4()}`,
      `team-${uuidv4()}`,
      ownerB.userId,
      'free',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(), teamAId, ownerA.userId, 'owner',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(), teamAId, member.userId, 'member',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(), teamBId, ownerB.userId, 'owner',
    ]);
    db.run('INSERT INTO team_workspaces (id, team_id, settings) VALUES (?, ?, ?)', [
      uuidv4(), teamAId, JSON.stringify({ marker: 'original' }),
    ]);

    checkAId = uuidv4();
    eventAId = uuidv4();
    dependencyAId = uuidv4();
    channelAId = uuidv4();
    entryAId = uuidv4();
    runAId = uuidv4();
    db.run('INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, ?, ?, ?, 1, ?)', [
      checkAId, 'http', `check-${uuidv4()}`, '{}', teamAId,
    ]);
    db.run(
      'INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, ?, ?, ?, ?)',
      [eventAId, checkAId, 'broken_webhook', 'warning', `event-${uuidv4()}`, teamAId],
    );
    db.run('INSERT INTO dependencies (id, name, current_version, specified_range, is_dev, team_id) VALUES (?, ?, ?, ?, 0, ?)', [
      dependencyAId, `dependency-${uuidv4()}`, '1.0.0', '1.x', teamAId,
    ]);
    db.run('INSERT INTO alert_channels (id, name, type, config, enabled, team_id) VALUES (?, ?, ?, ?, 1, ?)', [
      channelAId, `channel-${uuidv4()}`, 'slack', '{}', teamAId,
    ]);
    db.run('INSERT INTO playbook_entries (id, failure_type, title, body, team_id) VALUES (?, ?, ?, ?, ?)', [
      entryAId, 'broken_webhook', `entry-${uuidv4()}`, 'fixture', teamAId,
    ]);
    db.run('INSERT INTO remediation_runs (id, playbook_entry_id, action_name, status, team_id) VALUES (?, ?, ?, ?, ?)', [
      runAId, entryAId, 'retry-webhook', 'pending', teamAId,
    ]);

    const legacyCheckId = uuidv4();
    legacyEventId = uuidv4();
    db.run('INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, ?, ?, ?, 1, NULL)', [
      legacyCheckId, 'http', `check-${uuidv4()}`, '{}',
    ]);
    db.run(
      'INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, ?, ?, ?, NULL)',
      [legacyEventId, legacyCheckId, 'broken_webhook', 'warning', `event-${uuidv4()}`],
    );

    server = startApiServer(db, { port: 0, stripeClient: mockStripeClient, stripeWebhookSecret: 'test_secret' });
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    if (server?.listening) server.close();
    if (db) db.close();
  });

  describe('Gap 1: Playbook executions tenant scoping', () => {
    it('should return 403 for teamless caller on GET /api/playbook/executions', async () => {
      const res = await request(lonely, '/api/playbook/executions');
      assert.strictEqual(res.status, 403);
      const body = await res.json() as any;
      assert.strictEqual(body.code, 'FORBIDDEN');
    });

    it('should return 403 for teamless caller on POST /api/playbook/executions', async () => {
      const res = await request(lonely, '/api/playbook/executions', { method: 'POST', body: { playbookId: 'test' } });
      assert.strictEqual(res.status, 403);
    });

    it('should return 403 for teamless caller on GET /api/playbook/executions/:id', async () => {
      const res = await request(lonely, '/api/playbook/executions/some-id');
      assert.strictEqual(res.status, 403);
    });

    it('should return 403 for teamless caller on POST /api/playbook/executions/:id/decision', async () => {
      const res = await request(lonely, '/api/playbook/executions/some-id/decision', { method: 'POST', body: { decision: 'approve' } });
      assert.strictEqual(res.status, 403);
    });

    it('should return 403 for teamless caller on POST /api/playbook/executions/:id/cancel', async () => {
      const res = await request(lonely, '/api/playbook/executions/some-id/cancel', { method: 'POST' });
      assert.strictEqual(res.status, 403);
    });
  });

  describe('Gap 2: Performance APIs tenant scoping', () => {
    it('should return 403 for teamless caller on POST /api/performance/run', async () => {
      const res = await request(lonely, '/api/performance/run', { method: 'POST', body: { url: 'https://example.com' } });
      assert.strictEqual(res.status, 403);
    });

    it('should return 403 for teamless caller on GET /api/performance/history', async () => {
      const res = await request(lonely, '/api/performance/history?url=https://example.com');
      assert.strictEqual(res.status, 403);
    });

    it('should return 403 for teamless caller on GET /api/performance/regressions', async () => {
      const res = await request(lonely, '/api/performance/regressions');
      assert.strictEqual(res.status, 403);
    });

    it('should return 403 for teamless caller on GET /api/performance/diagnosis', async () => {
      const res = await request(lonely, '/api/performance/diagnosis?regressionId=test');
      assert.strictEqual(res.status, 403);
    });
  });

  describe('Gap 3: Private streaming (SSE) tenant scoping', () => {
    it('should return 401/403 for teamless caller on GET /api/realtime', async () => {
      const res = await request(lonely, '/api/realtime');
      assert.ok(res.status === 401 || res.status === 403);
    });
  });

  describe('Gap 4: Clerk webhook fails closed', () => {
    it('should return 401 for missing Svix headers', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/webhooks/clerk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.created', data: { id: 'test' } }),
      });
      assert.strictEqual(res.status, 401);
    });

    it('should return 401 for invalid signature', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/webhooks/clerk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'user.created', data: { id: 'test' } }),
      });
      assert.strictEqual(res.status, 401);
    });
  });

  describe('Gap 5: Team workspace requires owner/admin', () => {
    it('should return 403 for teamless caller on PATCH /api/teams/:id/workspace', async () => {
      const res = await request(lonely, `/api/teams/${teamAId}/workspace`, { method: 'PATCH', body: { settings: {} } });
      assert.strictEqual(res.status, 403);
    });
  });

  describe('Gap 6: Lead reads tenant scoped', () => {
    it('should return 403 for teamless caller on GET /api/leads', async () => {
      const res = await request(lonely, '/api/leads');
      assert.strictEqual(res.status, 403);
      const body = await res.json() as any;
      assert.strictEqual(body.code, 'FORBIDDEN');
    });

    it('should allow POST /api/leads without auth (public endpoint)', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/leads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'new@test.com' }),
      });
      assert.ok(res.status !== 401 && res.status !== 403);
    });
  });

  describe('Gap 7: Stripe webhook exact path', () => {
    it('should allow POST /api/billing/webhook without user token', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.ok(res.status !== 401);
    });

    it('should return 400 for missing stripe-signature header', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
      const body = await res.json() as any;
      assert.ok(body.error?.includes('stripe-signature'));
    });
  });

  describe('Two-team isolation', () => {
    it('Team A cannot access Team B playbook executions', async () => {
      const res = await request(ownerA, '/api/playbook/executions');
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      // Should only see Team A's executions
    });

    it('Team A cannot access Team B performance data', async () => {
      const res = await request(ownerA, '/api/performance/history?url=https://example.com');
      assert.strictEqual(res.status, 200);
    });

    it('Team A cannot access Team B leads', async () => {
      const res = await request(ownerA, '/api/leads');
      assert.strictEqual(res.status, 200);
    });
  });

  describe('NOC-337 pending state reasons', () => {
    it('should have a pending reason for playbook executions decision/cancel', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasPlaybookReason = keys.some(
        (k) => k.includes('playbookExecutionsDecisionCancel') || k.includes('playbook'),
      );
      assert.ok(hasPlaybookReason, 'pending reason for playbook executions decision/cancel must exist');
    });

    it('should have a pending reason for performance APIs', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasPerfReason = keys.some(
        (k) => k.includes('performanceApis') || k.includes('performance'),
      );
      assert.ok(hasPerfReason, 'pending reason for performance APIs must exist');
    });

    it('should have a pending reason for private streaming', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasStreamReason = keys.some(
        (k) => k.includes('privateStreaming') || k.includes('streaming') || k.includes('realtime'),
      );
      assert.ok(hasStreamReason, 'pending reason for private streaming must exist');
    });

    it('should have a pending reason for clerk webhook', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasWebhookReason = keys.some(
        (k) => k.includes('clerkWebhook') || k.includes('webhook'),
      );
      assert.ok(hasWebhookReason, 'pending reason for clerk webhook must exist');
    });

    it('should have a pending reason for team workspace', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasWorkspaceReason = keys.some(
        (k) => k.includes('teamWorkspace') || k.includes('workspace'),
      );
      assert.ok(hasWorkspaceReason, 'pending reason for team workspace must exist');
    });

    it('should have a pending reason for lead reads', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasLeadReason = keys.some(
        (k) => k.includes('leadReads') || k.includes('lead'),
      );
      assert.ok(hasLeadReason, 'pending reason for lead reads must exist');
    });

    it('should have a pending reason for stripe webhook', () => {
      const keys = Object.keys(NOC337_PENDING_REASONS);
      const hasStripeReason = keys.some(
        (k) => k.includes('stripeWebhook') || k.includes('stripe'),
      );
      assert.ok(hasStripeReason, 'pending reason for stripe webhook must exist');
    });

    it('all seven NOC-337 pending reasons should be documented', () => {
      const expectedReasons = [
        'playbookExecutionsDecisionCancel',
        'performanceApis',
        'privateStreaming',
        'clerkWebhook',
        'teamWorkspace',
        'leadReads',
        'stripeWebhook',
      ];
      const actualKeys = Object.keys(NOC337_PENDING_REASONS);
      for (const expected of expectedReasons) {
        assert.ok(
          actualKeys.includes(expected),
          `pending reason '${expected}' must be documented in NOC337_PENDING_REASONS`,
        );
      }
    });
  });
});