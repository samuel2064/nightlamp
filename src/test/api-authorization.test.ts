import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { appRouter, createTRPCContext, createTRPCContextFromNodeRequest } from '../api/trpc';
import { ApiAuthError, authenticateRequest, verifyAccessToken } from '../api/auth';
import { createPlaybookEngine } from '../playbook/engine';
import initSqlJs, { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { IncomingMessage } from 'http';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_JWT_SECRET, TEST_LOCAL_USER_ID } from './setup';
import { up as applyTenantIsolationMigration } from '../db/migrations/008-tenant-isolation';
import { evaluateAndNotify } from '../alerting/evaluator';
import { createServer } from 'http';

function nodeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('P0 API authorization', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;
  let otherTeamId: string;

  before(async () => {
    db = await createDatabase();

    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner@example.com', 'Owner']);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'Primary Team', 'primary-team', TEST_LOCAL_USER_ID, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, TEST_LOCAL_USER_ID, 'owner']);

    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['other-user', 'other-clerk-user', 'other@example.com', 'Other']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['personal-user', 'personal-clerk-user', 'personal@example.com', 'Personal']);

    otherTeamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [otherTeamId, 'Other Team', 'other-team', 'other-user', 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), otherTeamId, 'other-user', 'owner']);

    server = startApiServer(db, {
      port: 0,
      stripeClient: {
        stripe: {
          checkout: { sessions: { create: async (params: any) => ({ id: 'cs_test', url: 'https://checkout.stripe.com/test', ...params }) } },
          billingPortal: { sessions: { create: async (params: any) => ({ id: 'bps_test', url: 'https://billing.stripe.com/test', ...params }) } },
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

  describe('token verification', () => {
    it('accepts a correctly signed token', () => {
      const claims = verifyAccessToken(createTestToken({ sub: TEST_CLERK_USER_ID }));
      assert.strictEqual(claims.sub, TEST_CLERK_USER_ID);
    });

    it('rejects a token signed with a different secret', () => {
      const forged = createTestToken({ sub: 'attacker' }, 'not-the-real-secret');
      assert.throws(() => verifyAccessToken(forged), (err: any) => err instanceof ApiAuthError && err.statusCode === 401);
    });

    it('rejects an expired token', () => {
      const expired = createTestToken({ sub: TEST_CLERK_USER_ID, exp: Math.floor(Date.now() / 1000) - 120 });
      assert.throws(() => verifyAccessToken(expired), (err: any) => err instanceof ApiAuthError && err.statusCode === 401);
    });

    it('rejects a malformed token', () => {
      assert.throws(() => verifyAccessToken('not-a-jwt'), (err: any) => err instanceof ApiAuthError && err.statusCode === 401);
    });

    it('rejects a token whose subject is a non-string', () => {
      const malformed = createTestToken({ sub: 42 });
      assert.throws(() => verifyAccessToken(malformed), (err: any) => err instanceof ApiAuthError && err.statusCode === 401);
    });
  });

  describe('request authentication', () => {
    it('rejects a request without an Authorization header', () => {
      assert.throws(
        () => authenticateRequest(db, nodeRequest({})),
        (err: any) => err instanceof ApiAuthError && err.statusCode === 401
      );
    });

    it('rejects a request with an invalid bearer token', () => {
      assert.throws(
        () => authenticateRequest(db, nodeRequest({ authorization: 'Bearer forged.token.value' })),
        (err: any) => err instanceof ApiAuthError && err.statusCode === 401
      );
    });

    it('resolves the team and role for a valid token', () => {
      const auth = authenticateRequest(db, nodeRequest({
        authorization: `Bearer ${createTestToken({ sub: TEST_CLERK_USER_ID })}`,
      }));
      assert.strictEqual(auth.userId, TEST_LOCAL_USER_ID);
      assert.strictEqual(auth.teamId, teamId);
      assert.strictEqual(auth.role, 'owner');
    });

    it('forbids access to a team the caller does not belong to', () => {
      assert.throws(
        () => authenticateRequest(db, nodeRequest({
          authorization: `Bearer ${createTestToken({ sub: TEST_CLERK_USER_ID, org_id: otherTeamId })}`,
        })),
        (err: any) => err instanceof ApiAuthError && err.statusCode === 403
      );
    });
  });

  describe('REST endpoint gate', () => {
    it('returns 401 for an unauthenticated data request', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/events`);
      assert.strictEqual(res.status, 401);
      const body = await res.json() as any;
      assert.strictEqual(body.code, 'UNAUTHORIZED');
    });

    it('returns 401 for an unauthenticated mutation', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/remediation/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'run-1' }),
      });
      assert.strictEqual(res.status, 401);
    });

    it('returns 401 for unauthenticated team member listing', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/teams/${teamId}/members`);
      assert.strictEqual(res.status, 401);
    });

    it('returns 403 when a caller from another team reads team members', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/teams/${otherTeamId}/members`, {
        headers: { Authorization: `Bearer ${createTestToken({ sub: TEST_CLERK_USER_ID })}` },
      });
      assert.strictEqual(res.status, 403);
    });

    it('allows an authenticated caller to read data', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`);
      assert.strictEqual(res.status, 200);
    });

    it('keeps the health endpoint public for uptime checks', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(res.status, 200);
    });
  });

  describe('tRPC authorization', () => {
    it('builds an anonymous context when no token is present', () => {
      const ctx = createTRPCContextFromNodeRequest(db, createPlaybookEngine(db), nodeRequest({}));
      assert.strictEqual(ctx.user, null);
    });

    it('builds an authenticated context from a valid token', () => {
      const ctx = createTRPCContextFromNodeRequest(db, createPlaybookEngine(db), nodeRequest({
        authorization: `Bearer ${createTestToken({ sub: TEST_CLERK_USER_ID })}`,
      }));
      assert.ok(ctx.user);
      assert.strictEqual(ctx.user?.id, TEST_LOCAL_USER_ID);
      assert.ok(ctx.user?.teamIds.includes(teamId));
    });

    it('rejects protected procedures for anonymous callers', async () => {
      const ctx = createTRPCContext(db, createPlaybookEngine(db));
      const caller = appRouter.createCaller(ctx);
      await assert.rejects(
        () => caller.playbook.listPlaybooks({ teamId }),
        (err: any) => err.code === 'UNAUTHORIZED'
      );
    });

    it('rejects execution listing for anonymous callers', async () => {
      const ctx = createTRPCContext(db, createPlaybookEngine(db));
      const caller = appRouter.createCaller(ctx);
      await assert.rejects(
        () => caller.playbook.listExecutions(),
        (err: any) => err.code === 'UNAUTHORIZED'
      );
    });

    it('rejects playbook reads for a team the caller does not belong to', async () => {
      const playbookId = uuidv4();
      db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?)`,
        [playbookId, otherTeamId, 'Foreign Playbook', '', new Date().toISOString(), new Date().toISOString()]
      );

      const ctx = createTRPCContext(db, createPlaybookEngine(db));
      ctx.user = { id: TEST_LOCAL_USER_ID, email: 'owner@example.com', teamIds: [teamId], roles: { [teamId]: 'owner' } };
      const caller = appRouter.createCaller(ctx);

      await assert.rejects(
        () => caller.playbook.getPlaybook({ id: playbookId }),
        (err: any) => err.code === 'FORBIDDEN'
      );
    });

    it('rejects playbook updates for a member without an elevated role', async () => {
      const playbookId = uuidv4();
      db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?)`,
        [playbookId, teamId, 'Member Playbook', '', new Date().toISOString(), new Date().toISOString()]
      );

      const ctx = createTRPCContext(db, createPlaybookEngine(db));
      ctx.user = { id: TEST_LOCAL_USER_ID, email: 'owner@example.com', teamIds: [teamId], roles: { [teamId]: 'member' } };
      const caller = appRouter.createCaller(ctx);

      await assert.rejects(
        () => caller.playbook.updatePlaybook({ id: playbookId, name: 'hijacked' }),
        (err: any) => err.code === 'FORBIDDEN'
      );
    });
  });

  describe('remediation approval queue', () => {
    before(() => {
      db.run(`INSERT INTO playbook_entries (id, failure_type, title, body, team_id)
              VALUES ('queue-playbook', 'broken_webhook', 'Webhook failure', 'Inspect webhook delivery', ?)`, [teamId]);
      db.run(`INSERT INTO playbook_entries (id, failure_type, title, body, team_id)
              VALUES ('queue-foreign-playbook', 'expired_token', 'Foreign failure', 'Private description', ?)`, [otherTeamId]);
      for (const [id, owner, playbook] of [
        ['queue-own-a', teamId, 'queue-playbook'],
        ['queue-own-b', teamId, 'queue-playbook'],
        ['queue-foreign', otherTeamId, 'queue-foreign-playbook'],
        ['queue-personal', null, null],
      ]) {
        db.run(`INSERT INTO remediation_runs (id, action_name, team_id, playbook_entry_id, created_at)
                VALUES (?, 'retry-webhook', ?, ?, '2026-11-16 10:00:00')`, [id, owner, playbook]);
      }
      db.run(`INSERT INTO remediation_runs (id, action_name, team_id, playbook_entry_id, status, started_at, completed_at)
              VALUES ('queue-success', 'retry-webhook', ?, 'queue-playbook', 'success', '2026-11-16 09:00:00', '2026-11-16 09:01:00')`, [teamId]);
      db.run(`INSERT INTO remediation_runs (id, action_name, team_id, playbook_entry_id, status)
              VALUES ('queue-cross-link', 'rotate-token', ?, 'queue-foreign-playbook', 'failed')`, [teamId]);
    });

    async function queue(query = '', token = createTestToken()): Promise<any> {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/remediation/runs${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.strictEqual(res.status, 200);
      return res.json();
    }

    it('denies unauthenticated requests including the trailing-slash route', async () => {
      for (const path of ['/api/remediation/runs', '/api/remediation/runs/']) {
        const res = await fetchWithoutAuth(`http://127.0.0.1:${port}${path}`);
        assert.strictEqual(res.status, 401);
      }
    });

    it('defaults to pending runs in the authenticated tenant and returns the exact envelope', async () => {
      const body = await queue();
      assert.deepStrictEqual(Object.keys(body).sort(), ['count', 'runs']);
      assert.strictEqual(body.count, 2);
      assert.deepStrictEqual(body.runs.map((run: any) => run.id), ['queue-own-a', 'queue-own-b']);
      assert.deepStrictEqual(body.runs[0], {
        id: 'queue-own-a', playbook_entry_id: 'queue-playbook', action_name: 'retry-webhook',
        status: 'pending', initiated_by: null, approved_by: null, output: null, error: null,
        created_at: '2026-11-16 10:00:00', started_at: null, completed_at: null,
        affected_resource: 'queue-playbook', failure_type: 'broken_webhook', description: 'Inspect webhook delivery',
      });
    });

    it('filters status and preserves execution timestamps', async () => {
      const body = await queue('?status=success');
      assert.strictEqual(body.count, 1);
      assert.strictEqual(body.runs[0].id, 'queue-success');
      assert.strictEqual(body.runs[0].status, 'success');
      assert.strictEqual(body.runs[0].started_at, '2026-11-16 09:00:00');
      assert.strictEqual(body.runs[0].completed_at, '2026-11-16 09:01:00');
      assert.deepStrictEqual(await queue('?status=pending_approval'), { runs: [], count: 0 });
    });

    it('paginates deterministically while counting all tenant-visible matches', async () => {
      const body = await queue('?limit=1&offset=1');
      assert.strictEqual(body.count, 2);
      assert.deepStrictEqual(body.runs.map((run: any) => run.id), ['queue-own-b']);
      assert.deepStrictEqual(await queue('?limit=1&offset=2'), { runs: [], count: 2 });
    });

    it('keeps null-team legacy runs exclusively in personal scope', async () => {
      const body = await queue('', createTestToken({ sub: 'personal-clerk-user' }));
      assert.strictEqual(body.count, 1);
      assert.deepStrictEqual(body.runs.map((run: any) => run.id), ['queue-personal']);
      assert.strictEqual(body.runs[0].description, null);
    });

    it('does not leak linked playbook contents across tenant boundaries', async () => {
      const body = await queue('?status=failed');
      assert.strictEqual(body.count, 1);
      assert.strictEqual(body.runs[0].id, 'queue-cross-link');
      assert.strictEqual(body.runs[0].failure_type, null);
      assert.strictEqual(body.runs[0].description, null);
    });

    it('rejects invalid pagination', async () => {
      for (const query of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=abc', 'offset=9007199254740992']) {
        const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/remediation/runs?${query}`, {
          headers: { Authorization: `Bearer ${createTestToken()}` },
        });
        assert.strictEqual(res.status, 400, query);
      }
    });

    it('advertises the endpoint in the unknown-path route catalogue', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/unknown-route`);
      assert.strictEqual(res.status, 404);
      const body = await res.json() as any;
      assert.ok(body.available.includes('/api/remediation/runs'));
    });

    after(() => {
      db.run("DELETE FROM remediation_runs WHERE id LIKE 'queue-%'");
      db.run("DELETE FROM playbook_entries WHERE id LIKE 'queue-%'");
    });
  });

  describe('REST tenant isolation', () => {
    const ownCheckId = 'own-check';
    const foreignCheckId = 'foreign-check';
    const ownResultId = 'own-result';
    const foreignResultId = 'foreign-result';
    const ownEventId = 'own-event';
    const foreignEventId = 'foreign-event';
    const ownPlaybookId = 'own-playbook';
    const foreignPlaybookId = 'foreign-playbook';
    const ownDependencyId = 'own-dependency';
    const foreignDependencyId = 'foreign-dependency';
    const ownUpdateId = 'own-update';
    const foreignUpdateId = 'foreign-update';
    const ownCustomerId = 'own-customer';
    const foreignCustomerId = 'foreign-customer';
    const ownSubscriptionId = 'own-subscription';
    const foreignSubscriptionId = 'foreign-subscription';
    const ownRemediationLogId = 'own-remediation-log';
    const foreignRemediationLogId = 'foreign-remediation-log';
    const ownRunId = 'own-remediation-run';
    const foreignRunId = 'foreign-remediation-run';
    const ownPolicyId = 'own-remediation-policy';
    const foreignPolicyId = 'foreign-remediation-policy';
    const ownChannelId = 'own-channel';
    const foreignChannelId = 'foreign-channel';
    const ownRuleId = 'own-rule';
    const foreignRuleId = 'foreign-rule';
    const ownSessionId = 'own-session';
    const foreignSessionId = 'foreign-session';
    const ownPostId = 'own-post';
    const foreignPostId = 'foreign-post';
    const ownWebhookEventId = 'own-webhook-event';
    const foreignWebhookEventId = 'foreign-webhook-event';
    const ownCustomPlaybookId = 'own-custom-playbook';
    const foreignCustomPlaybookId = 'foreign-custom-playbook';
    const legacyCheckId = 'legacy-check';
    const legacyEventId = 'legacy-event';

    before(() => {
      db.run(
        `INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, 'sentry', 'Own Check', '{}', 1, ?)`,
        [ownCheckId, teamId],
      );
      db.run(
        `INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, 'sentry', 'Foreign Check', '{}', 1, ?)`,
        [foreignCheckId, otherTeamId],
      );
      db.run(
        `INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, 'sentry', 'Legacy Check', '{}', 1, NULL)`,
        [legacyCheckId],
      );
      db.run(
        `INSERT INTO check_results (id, check_id, status, summary, team_id) VALUES (?, ?, 'pass', 'Own result', ?)`,
        [ownResultId, ownCheckId, teamId],
      );
      db.run(
        `INSERT INTO check_results (id, check_id, status, summary, team_id) VALUES (?, ?, 'pass', 'Foreign result', ?)`,
        [foreignResultId, foreignCheckId, otherTeamId],
      );
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, 'own_type', 'warning', 'Own event', ?)`,
        [ownEventId, ownCheckId, teamId],
      );
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, 'foreign_type', 'warning', 'Foreign event', ?)`,
        [foreignEventId, foreignCheckId, otherTeamId],
      );
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, 'legacy_type', 'warning', 'Legacy event', NULL)`,
        [legacyEventId, legacyCheckId],
      );
      db.run(
        `INSERT INTO playbook_entries (id, failure_type, title, body, team_id) VALUES (?, 'own_type', 'Own Playbook', 'Own body', ?)`,
        [ownPlaybookId, teamId],
      );
      db.run(
        `INSERT INTO playbook_entries (id, failure_type, title, body, team_id) VALUES (?, 'foreign_type', 'Foreign isolationmarker', 'Foreign body', ?)`,
        [foreignPlaybookId, otherTeamId],
      );
      db.run(
        `INSERT INTO dependencies (id, name, current_version, specified_range, is_dev, team_id) VALUES (?, 'own-package', '1.0.0', '1.x', 0, ?)`,
        [ownDependencyId, teamId],
      );
      db.run(
        `INSERT INTO dependencies (id, name, current_version, specified_range, is_dev, team_id) VALUES (?, 'foreign-package', '1.0.0', '1.x', 0, ?)`,
        [foreignDependencyId, otherTeamId],
      );
      db.run(
        `INSERT INTO dependency_updates (id, dependency_id, available_version, current_version, change_type, is_breaking, team_id) VALUES (?, ?, '2.0.0', '1.0.0', 'major', 1, ?)`,
        [ownUpdateId, ownDependencyId, teamId],
      );
      db.run(
        `INSERT INTO dependency_updates (id, dependency_id, available_version, current_version, change_type, is_breaking, team_id) VALUES (?, ?, '2.0.0', '1.0.0', 'major', 1, ?)`,
        [foreignUpdateId, foreignDependencyId, otherTeamId],
      );
      db.run(
        `INSERT INTO customers (id, email, name, team_id) VALUES (?, 'own@example.com', 'Own Customer', ?)`,
        [ownCustomerId, teamId],
      );
      db.run(
        `INSERT INTO customers (id, email, name, team_id) VALUES (?, 'foreign@example.com', 'Foreign Customer', ?)`,
        [foreignCustomerId, otherTeamId],
      );
      db.run(
        `INSERT INTO subscriptions (id, customer_id, plan_tier, status, team_id) VALUES (?, ?, 'basic', 'active', ?)`,
        [ownSubscriptionId, ownCustomerId, teamId],
      );
      db.run(
        `INSERT INTO subscriptions (id, customer_id, plan_tier, status, team_id) VALUES (?, ?, 'advanced', 'active', ?)`,
        [foreignSubscriptionId, foreignCustomerId, otherTeamId],
      );
      db.run(
        `INSERT INTO usage_records (id, customer_id, metric, value, team_id) VALUES (?, ?, 'monitors', 7, ?)`,
        [uuidv4(), ownCustomerId, teamId],
      );
      db.run(
        `INSERT INTO usage_records (id, customer_id, metric, value, team_id) VALUES (?, ?, 'monitors', 99, ?)`,
        [uuidv4(), foreignCustomerId, otherTeamId],
      );
      db.run(
        `INSERT INTO remediation_log (id, playbook_entry_id, failure_type, script, status, team_id) VALUES (?, ?, 'own_type', 'own-script', 'success', ?)`,
        [ownRemediationLogId, ownPlaybookId, teamId],
      );
      db.run(
        `INSERT INTO remediation_log (id, playbook_entry_id, failure_type, script, status, team_id) VALUES (?, ?, 'foreign_type', 'foreign-script', 'success', ?)`,
        [foreignRemediationLogId, foreignPlaybookId, otherTeamId],
      );
      db.run(
        `INSERT INTO remediation_runs (id, playbook_entry_id, action_name, status, team_id) VALUES (?, ?, 'own-action', 'pending', ?)`,
        [ownRunId, ownPlaybookId, teamId],
      );
      db.run(
        `INSERT INTO remediation_runs (id, playbook_entry_id, action_name, status, team_id) VALUES (?, ?, 'foreign-action', 'pending', ?)`,
        [foreignRunId, foreignPlaybookId, otherTeamId],
      );
      db.run(
        `INSERT INTO remediation_policies (id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes) VALUES (?, ?, 'own_type', 0, 1, 60)`,
        [ownPolicyId, teamId],
      );
      db.run(
        `INSERT INTO remediation_policies (id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes) VALUES (?, ?, 'foreign_type', 0, 1, 60)`,
        [foreignPolicyId, otherTeamId],
      );
      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Own Channel', 'slack', '{}', ?)`,
        [ownChannelId, teamId],
      );
      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Foreign Channel', 'slack', '{}', ?)`,
        [foreignChannelId, otherTeamId],
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, team_id) VALUES (?, 'Own Rule', ?, '["own_type"]', 'warning', ?)`,
        [ownRuleId, ownChannelId, teamId],
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, team_id) VALUES (?, 'Foreign Rule', ?, '["foreign_type"]', 'warning', ?)`,
        [foreignRuleId, foreignChannelId, otherTeamId],
      );
      db.run(
        `INSERT INTO alert_log (id, rule_id, channel_id, failure_type, severity, channel_type, status) VALUES (?, ?, ?, 'foreign_type', 'warning', 'slack', 'sent')`,
        ['foreign-alert-log', foreignRuleId, foreignChannelId],
      );
      db.run(
        `INSERT INTO onboarding_sessions (id, user_id, current_step, step_data, team_id) VALUES (?, ?, 'app-detection', '{}', ?)`,
        [ownSessionId, TEST_LOCAL_USER_ID, teamId],
      );
      db.run(
        `INSERT INTO onboarding_sessions (id, user_id, current_step, step_data, team_id) VALUES (?, ?, 'app-detection', '{}', ?)`,
        [foreignSessionId, 'other-user', otherTeamId],
      );
      db.run(
        `INSERT INTO x_scheduled_posts (id, tweet_text, position, status, team_id) VALUES (?, 'Own post', 1, 'pending', ?)`,
        [ownPostId, teamId],
      );
      db.run(
        `INSERT INTO x_scheduled_posts (id, tweet_text, position, status, team_id) VALUES (?, 'Foreign post', 1, 'pending', ?)`,
        [foreignPostId, otherTeamId],
      );
      db.run(
        `INSERT INTO webhook_events (id, provider, event_type, status, team_id) VALUES (?, 'stripe', 'own.event', 'processed', ?)`,
        [ownWebhookEventId, teamId],
      );
      db.run(
        `INSERT INTO webhook_events (id, provider, event_type, status, team_id) VALUES (?, 'stripe', 'foreign.event', 'processed', ?)`,
        [foreignWebhookEventId, otherTeamId],
      );
      db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, 'Own Custom Playbook', '', 'draft', 1, ?, ?)`,
        [ownCustomPlaybookId, teamId, new Date().toISOString(), new Date().toISOString()],
      );
      db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, 'Foreign Custom Playbook', '', 'draft', 1, ?, ?)`,
        [foreignCustomPlaybookId, otherTeamId, new Date().toISOString(), new Date().toISOString()],
      );
    });

    async function getJson(path: string, token: string = createTestToken()): Promise<any> {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.json() as Promise<any>;
    }

    const protectedEndpoints = [
      '/api/events',
      '/api/check-results',
      '/api/playbook',
      '/api/playbook/search?q=isolationmarker',
      '/api/playbook/match?symptoms=isolationmarker',
      '/api/playbook/correlations?failureType=foreign_type',
      '/api/playbook/remediation-logs',
      '/api/dependencies',
      '/api/dependencies/updates',
      '/api/dependency-health',
      '/api/monitors',
      '/api/incidents',
      '/api/activity',
      '/api/remediation/policies',
      '/api/alerting/channels',
      '/api/alerting/rules',
      '/api/alerting/log',
      '/api/notifications/channels',
      '/api/x/posts',
      '/api/billing/summary',
      '/api/billing/subscriptions',
      '/api/billing/webhook-events',
    ];

    for (const endpoint of protectedEndpoints) {
      it(`does not expose another tenant's rows through ${endpoint}`, async () => {
        const body = await getJson(endpoint);
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes(foreignCheckId), `${endpoint} exposed a foreign check`);
        assert.ok(!serialized.includes(foreignResultId), `${endpoint} exposed a foreign result`);
        assert.ok(!serialized.includes(foreignEventId), `${endpoint} exposed a foreign event`);
        assert.ok(!serialized.includes(foreignPlaybookId), `${endpoint} exposed a foreign playbook`);
        assert.ok(!serialized.includes(foreignDependencyId), `${endpoint} exposed a foreign dependency`);
        assert.ok(!serialized.includes(foreignUpdateId), `${endpoint} exposed a foreign dependency update`);
        assert.ok(!serialized.includes(foreignCustomerId), `${endpoint} exposed a foreign customer`);
        assert.ok(!serialized.includes(foreignSubscriptionId), `${endpoint} exposed a foreign subscription`);
        assert.ok(!serialized.includes(foreignRemediationLogId), `${endpoint} exposed a foreign remediation log`);
        assert.ok(!serialized.includes(foreignPolicyId), `${endpoint} exposed a foreign remediation policy`);
        assert.ok(!serialized.includes(foreignChannelId), `${endpoint} exposed a foreign channel`);
        assert.ok(!serialized.includes(foreignRuleId), `${endpoint} exposed a foreign rule`);
        assert.ok(!serialized.includes(foreignPostId), `${endpoint} exposed a foreign post`);
        assert.ok(!serialized.includes(foreignWebhookEventId), `${endpoint} exposed a foreign webhook event`);
      });
    }

    it('does not return another tenant billing customer or subscription', async () => {
      const subscription = await getJson(`/api/billing/subscription?customerId=${foreignCustomerId}`);
      assert.strictEqual(subscription.subscription, null);
      const usage = await getJson(`/api/billing/usage?customerId=${foreignCustomerId}`);
      assert.strictEqual(usage.usage.monitors, 0);
    });

    it('does not return another tenant onboarding session', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/onboarding/${foreignSessionId}/status`, {
        headers: { Authorization: `Bearer ${createTestToken()}` },
      });
      assert.strictEqual(res.status, 404);
    });

    it('does not allow a tenant to mutate another tenant channel', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/alerting/channels/${foreignChannelId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${createTestToken()}` },
      });
      assert.strictEqual(res.status, 404);
      const row = db.exec('SELECT id FROM alert_channels WHERE id = ?', [foreignChannelId]);
      assert.strictEqual(row[0].values.length, 1);
    });

    it('does not allow a tenant to approve another tenant remediation run', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/remediation/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${createTestToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: foreignRunId }),
      });
      assert.strictEqual(res.status, 400);
      const row = db.exec('SELECT status FROM remediation_runs WHERE id = ?', [foreignRunId]);
      assert.strictEqual(row[0].values[0][0], 'pending');
    });

    it('keeps personal legacy rows available only to personal scope', async () => {
      const teamEvents = await getJson('/api/events');
      assert.ok(!teamEvents.events.some((event: any) => event.id === legacyEventId));
      const personalToken = createTestToken({ sub: 'personal-clerk-user' });
      const personalEvents = await getJson('/api/events', personalToken);
      assert.ok(personalEvents.events.some((event: any) => event.id === legacyEventId));
      assert.ok(!personalEvents.events.some((event: any) => event.id === ownEventId || event.id === foreignEventId));
    });

    it('stores new tenant-owned rows with the authenticated team id', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/alerting/channels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${createTestToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Created Channel', type: 'slack', config: { webhookUrl: 'https://example.com' } }),
      });
      const body = await res.json() as any;
      assert.strictEqual(res.status, 200);
      const row = db.exec('SELECT team_id FROM alert_channels WHERE id = ?', [body.id]);
      assert.strictEqual(row[0].values[0][0], teamId);
    });

    it('does not expose or mutate another tenant custom playbook', async () => {
      const list = await getJson('/api/playbooks/custom');
      assert.ok(list.playbooks.some((p: any) => p.id === ownCustomPlaybookId));
      assert.ok(!list.playbooks.some((p: any) => p.id === foreignCustomPlaybookId));

      const getRes = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/playbooks/custom/${foreignCustomPlaybookId}`, {
        headers: { Authorization: `Bearer ${createTestToken()}` },
      });
      assert.strictEqual(getRes.status, 404);

      const patchRes = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/playbooks/custom/${foreignCustomPlaybookId}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${createTestToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Hijacked' }),
      });
      assert.strictEqual(patchRes.status, 404);

      const deleteRes = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/playbooks/custom/${foreignCustomPlaybookId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${createTestToken()}` },
      });
      assert.strictEqual(deleteRes.status, 404);
      const row = db.exec('SELECT name FROM custom_playbooks WHERE id = ?', [foreignCustomPlaybookId]);
      assert.strictEqual(row[0].values[0][0], 'Foreign Custom Playbook');
    });

    it('rejects creating a custom playbook for another organization', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/playbooks/custom`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${createTestToken()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ teamId: otherTeamId, name: 'Cross Tenant Playbook' }),
      });
      assert.strictEqual(res.status, 403);
      const row = db.exec("SELECT COUNT(*) FROM custom_playbooks WHERE name = 'Cross Tenant Playbook'");
      assert.strictEqual(row[0].values[0][0], 0);
    });

    it('scopes report aggregates to the authenticated tenant', async () => {
      const trends = await getJson('/api/reports/incident-trends');
      assert.ok(!trends.types.includes('foreign_type'));
      assert.ok(trends.types.includes('own_type'));

      const uptime = await getJson('/api/reports/uptime-stats');
      assert.ok(uptime.monitors.some((m: any) => m.monitorId === ownCheckId));
      assert.ok(!uptime.monitors.some((m: any) => m.monitorId === foreignCheckId));

      const effectiveness = await getJson('/api/reports/playbook-effectiveness');
      assert.ok(effectiveness.entries.some((e: any) => e.id === ownPlaybookId));
      assert.ok(!effectiveness.entries.some((e: any) => e.id === foreignPlaybookId));

      const summary = await getJson('/api/reports/team-summary');
      assert.strictEqual(summary.teams.total, 1);
      assert.strictEqual(summary.monitoring.totalMonitors, 1);
    });

    it('does not deliver another tenant alert rules for a tenant event', async () => {
      const received: string[] = [];
      const capture = createServer((req, res) => {
        received.push(req.url || '');
        res.writeHead(200);
        res.end('ok');
      });
      await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', () => resolve()));
      const captureUrl = `http://127.0.0.1:${(capture.address() as any).port}/notify`;

      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Foreign WS Channel', 'in-app-websocket', ?, ?)`,
        ['foreign-ws-channel', JSON.stringify({ url: captureUrl }), otherTeamId],
      );
      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Own WS Channel', 'in-app-websocket', ?, ?)`,
        ['own-ws-channel', JSON.stringify({ url: captureUrl }), teamId],
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, team_id) VALUES (?, 'Foreign Eval Rule', 'foreign-ws-channel', ?, 'info', ?)`,
        ['foreign-eval-rule', JSON.stringify(['eval_type']), otherTeamId],
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, team_id) VALUES (?, 'Own Eval Rule', 'own-ws-channel', ?, 'info', ?)`,
        ['own-eval-rule', JSON.stringify(['eval_type']), teamId],
      );
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, 'eval_type', 'warning', 'Eval event', ?)`,
        ['eval-event', ownCheckId, teamId],
      );

      await evaluateAndNotify(db, 'eval_type', 'warning', 'Eval event', 'desc', new Date().toISOString(), ownCheckId, 'eval-event');

      const logs = db.exec('SELECT rule_id FROM alert_log WHERE failure_event_id = ?', ['eval-event']);
      const ruleIds = logs.length > 0 ? logs[0].values.map((row: any) => row[0] as string) : [];
      assert.ok(!ruleIds.includes('foreign-eval-rule'));
      assert.ok(ruleIds.includes('own-eval-rule'));
      assert.strictEqual(received.length, 1);

      capture.close();
    });

    it('does not list another tenant in the team directory', async () => {
      const list = await getJson('/api/teams');
      const teamIds = list.teams.map((t: any) => t.id as string);
      assert.ok(teamIds.includes(teamId));
      assert.ok(!teamIds.includes(otherTeamId));
    });
  });

  describe('tenant migration', () => {
    it('adds team columns to a legacy database with ALTER TABLE', async () => {
      const SQL = await initSqlJs();
      const legacyDb = new SQL.Database();
      legacyDb.run('CREATE TABLE checks (id TEXT PRIMARY KEY, source TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL)');
      legacyDb.run("INSERT INTO checks (id, source, name, config) VALUES ('legacy-id', 'sentry', 'Legacy', '{}')");
      applyTenantIsolationMigration(legacyDb);
      const columns = legacyDb.exec('PRAGMA table_info(checks)');
      assert.ok(columns[0].values.some((row: any) => row[1] === 'team_id'));
      const row = legacyDb.exec('SELECT team_id FROM checks WHERE id = ?', ['legacy-id']);
      assert.strictEqual(row[0].values[0][0], null);
      legacyDb.close();
    });
  });
});
