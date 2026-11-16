import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { setDb } from '../remediation/engine';
import { createTestToken, fetchWithoutAuth } from './setup';
import { v4 as uuidv4 } from 'uuid';
import assert from 'assert';
import { Server } from 'http';
import { Database } from 'sql.js';

const TEAM_A_CLERK = 'clerk-tenant-a';
const TEAM_B_CLERK = 'clerk-tenant-b';
const LONELY_CLERK = 'clerk-no-team';

describe('cross-tenant mutation sweep', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamA: string;
  let teamB: string;
  let channelId: string;
  let ruleId: string;
  let entryId: string;
  let runId: string;
  let playbookId: string;
  let checkId: string;
  let eventId: string;
  let postId: string;

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; clerkId?: string } = {},
  ): Promise<{ status: number; payload: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.clerkId) {
      headers.Authorization = `Bearer ${createTestToken({ sub: options.clerkId })}`;
    }
    const res = await fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    let payload: any = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return { status: res.status, payload };
  }

  function scalar(sql: string, params: unknown[] = []): any {
    const result = db.exec(sql, params as any[]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0][0];
  }

  before(async () => {
    db = await createDatabase();
    setDb(db);

    const userA = 'sweep-user-a';
    const userB = 'sweep-user-b';
    const userL = 'sweep-user-lonely';
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [userA, TEAM_A_CLERK, 'a@example.com', 'Tenant A']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [userB, TEAM_B_CLERK, 'b@example.com', 'Tenant B']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [userL, LONELY_CLERK, 'l@example.com', 'No Team']);

    teamA = uuidv4();
    teamB = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamA, 'Tenant A', 'tenant-a', userA, 'free']);
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamB, 'Tenant B', 'tenant-b', userB, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamA, userA, 'owner']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamB, userB, 'owner']);

    channelId = uuidv4();
    db.run('INSERT INTO alert_channels (id, name, type, config, enabled, team_id) VALUES (?, ?, ?, ?, ?, ?)',
      [channelId, 'Tenant A channel', 'slack', '{"url":"https://example.invalid"}', 1, teamA]);

    ruleId = uuidv4();
    db.run('INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, enabled, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [ruleId, 'Tenant A rule', channelId, '["error_spike"]', 'info', 1, teamA]);

    entryId = uuidv4();
    db.run('INSERT INTO playbook_entries (id, failure_type, title, body, team_id) VALUES (?, ?, ?, ?, ?)',
      [entryId, 'error_spike', 'Tenant A entry', 'body', teamA]);

    runId = uuidv4();
    db.run('INSERT INTO remediation_runs (id, playbook_entry_id, action_name, status, initiated_by, team_id) VALUES (?, ?, ?, ?, ?, ?)',
      [runId, entryId, 'restart-service', 'pending', userA, teamA]);

    playbookId = uuidv4();
    db.run('INSERT INTO custom_playbooks (id, team_id, name, description) VALUES (?, ?, ?, ?)',
      [playbookId, teamA, 'Tenant A playbook', 'owned by tenant A']);

    checkId = uuidv4();
    db.run('INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, ?, ?, ?, ?, ?)',
      [checkId, 'sentry', 'Tenant A check', '{}', 1, teamA]);

    eventId = uuidv4();
    db.run('INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id) VALUES (?, ?, ?, ?, ?, ?)',
      [eventId, checkId, 'error_spike', 'critical', 'Tenant A event', teamA]);

    postId = uuidv4();
    db.run('INSERT INTO x_scheduled_posts (id, tweet_text, position, status, team_id) VALUES (?, ?, ?, ?, ?)',
      [postId, 'tenant a tweet', 1, 'pending', teamA]);

    server = startApiServer(db, { port: 0 } as any);
    port = (server.address() as any).port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  describe('alert channels and rules', () => {
    it('refuses to delete another tenant\'s channel and leaves the row intact', async () => {
      const res = await call('DELETE', `/api/alerting/channels/${channelId}`, { clerkId: TEAM_B_CLERK });
      assert.ok(res.status === 404 || res.status === 403, `expected 404 or 403, got ${res.status}`);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM alert_channels WHERE id = ?', [channelId]), 1);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM alert_rules WHERE id = ?', [ruleId]), 1);
    });

    it('refuses to edit another tenant\'s channel and leaves the row intact', async () => {
      const res = await call('PUT', `/api/alerting/channels/${channelId}`, {
        clerkId: TEAM_B_CLERK,
        body: { name: 'hijacked', enabled: false },
      });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.payload.error, 'Channel not found');
      assert.strictEqual(scalar('SELECT name FROM alert_channels WHERE id = ?', [channelId]), 'Tenant A channel');
      assert.strictEqual(scalar('SELECT enabled FROM alert_channels WHERE id = ?', [channelId]), 1);
    });

    it('refuses to delete or edit another tenant\'s rule', async () => {
      const del = await call('DELETE', `/api/alerting/rules/${ruleId}`, { clerkId: TEAM_B_CLERK });
      assert.strictEqual(del.status, 404);
      assert.strictEqual(del.payload.error, 'Rule not found');
      assert.strictEqual(scalar('SELECT COUNT(*) FROM alert_rules WHERE id = ?', [ruleId]), 1);

      const put = await call('PUT', `/api/alerting/rules/${ruleId}`, {
        clerkId: TEAM_B_CLERK,
        body: { name: 'hijacked', enabled: false },
      });
      assert.strictEqual(put.status, 404);
      assert.strictEqual(put.payload.error, 'Rule not found');
      assert.strictEqual(scalar('SELECT name FROM alert_rules WHERE id = ?', [ruleId]), 'Tenant A rule');
      assert.strictEqual(scalar('SELECT enabled FROM alert_rules WHERE id = ?', [ruleId]), 1);
    });

    it('refuses to attach a new rule to another tenant\'s channel', async () => {
      const before = scalar('SELECT COUNT(*) FROM alert_rules WHERE channel_id = ?', [channelId]);
      const res = await call('POST', '/api/alerting/rules', {
        clerkId: TEAM_B_CLERK,
        body: { name: 'injected', channelId, failureTypes: ['error_spike'] },
      });
      assert.ok(res.status === 404 || res.status === 403, `expected 404 or 403, got ${res.status}`);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM alert_rules WHERE channel_id = ?', [channelId]), before);
    });

    it('lets the owning tenant update its channel', async () => {
      const ownerChannelId = uuidv4();
      db.run('INSERT INTO alert_channels (id, name, type, config, enabled, team_id) VALUES (?, ?, ?, ?, ?, ?)',
        [ownerChannelId, 'Owner channel', 'slack', '{"url":"https://example.invalid"}', 1, teamA]);

      const res = await call('PUT', `/api/alerting/channels/${ownerChannelId}`, {
        clerkId: TEAM_A_CLERK,
        body: { name: 'Updated channel', enabled: false },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(scalar('SELECT name FROM alert_channels WHERE id = ?', [ownerChannelId]), 'Updated channel');
      assert.strictEqual(scalar('SELECT enabled FROM alert_channels WHERE id = ?', [ownerChannelId]), 0);
    });
  });

  describe('remediation runs', () => {
    it('leaves another tenant\'s run untouched on approve, reject and retry', async () => {
      const approve = await call('POST', '/api/remediation/approve', { clerkId: TEAM_B_CLERK, body: { id: runId } });
      assert.notStrictEqual(approve.status, 200, 'approve must not report success for a foreign run');

      const retry = await call('POST', '/api/remediation/retry', { clerkId: TEAM_B_CLERK, body: { id: runId } });
      assert.notStrictEqual(retry.status, 200, 'retry must not report success for a foreign run');

      const reject = await call('POST', '/api/remediation/reject', { clerkId: TEAM_B_CLERK, body: { id: runId } });
      assert.notStrictEqual(reject.status, 200, 'reject must not report success for a foreign run');
      assert.strictEqual(reject.status, 400);
      assert.strictEqual(reject.payload.error, 'Run not found');

      assert.strictEqual(scalar('SELECT status FROM remediation_runs WHERE id = ?', [runId]), 'pending');
      assert.strictEqual(scalar('SELECT output FROM remediation_runs WHERE id = ?', [runId]), null);
      assert.strictEqual(scalar('SELECT completed_at FROM remediation_runs WHERE id = ?', [runId]), null);
    });

    it('leaves another tenant\'s run untouched for a signed-in user with no membership', async () => {
      const approve = await call('POST', '/api/remediation/approve', { clerkId: LONELY_CLERK, body: { id: runId } });
      assert.notStrictEqual(approve.status, 200);
      await call('POST', '/api/remediation/reject', { clerkId: LONELY_CLERK, body: { id: runId } });
      assert.strictEqual(scalar('SELECT status FROM remediation_runs WHERE id = ?', [runId]), 'pending');
    });

    it('lets the owning tenant reject its run', async () => {
      const ownerRunId = uuidv4();
      db.run('INSERT INTO remediation_runs (id, playbook_entry_id, action_name, status, initiated_by, team_id) VALUES (?, ?, ?, ?, ?, ?)',
        [ownerRunId, entryId, 'restart-service', 'pending', 'sweep-user-a', teamA]);

      const res = await call('POST', '/api/remediation/reject', {
        clerkId: TEAM_A_CLERK,
        body: { id: ownerRunId },
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.payload.success, true);
      assert.strictEqual(scalar('SELECT status FROM remediation_runs WHERE id = ?', [ownerRunId]), 'rejected');
    });
  });

  describe('events', () => {
    it('refuses to acknowledge another tenant\'s event', async () => {
      const res = await call('POST', '/api/events/acknowledge', { clerkId: TEAM_B_CLERK, body: { id: eventId } });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(scalar('SELECT acknowledged FROM failure_events WHERE id = ?', [eventId]), 0);
    });
  });

  describe('custom playbooks', () => {
    it('refuses to read, edit, publish or delete another tenant\'s playbook', async () => {
      const get = await call('GET', `/api/playbooks/custom/${playbookId}`, { clerkId: TEAM_B_CLERK });
      assert.strictEqual(get.status, 404);

      const patch = await call('PATCH', `/api/playbooks/custom/${playbookId}`, {
        clerkId: TEAM_B_CLERK,
        body: { name: 'hijacked' },
      });
      assert.strictEqual(patch.status, 404);
      assert.strictEqual(scalar('SELECT name FROM custom_playbooks WHERE id = ?', [playbookId]), 'Tenant A playbook');

      const publish = await call('POST', `/api/playbooks/custom/${playbookId}/publish`, { clerkId: TEAM_B_CLERK });
      assert.strictEqual(publish.status, 404);
      assert.strictEqual(scalar('SELECT status FROM custom_playbooks WHERE id = ?', [playbookId]), 'draft');

      const del = await call('DELETE', `/api/playbooks/custom/${playbookId}`, { clerkId: TEAM_B_CLERK });
      assert.strictEqual(del.status, 404);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM custom_playbooks WHERE id = ?', [playbookId]), 1);
    });
  });

  describe('list endpoints', () => {
    it('never returns another tenant\'s rows', async () => {
      const channels = await call('GET', '/api/alerting/channels', { clerkId: TEAM_B_CLERK });
      assert.strictEqual(channels.status, 200);
      assert.ok(!(channels.payload.channels || []).some((c: any) => c.id === channelId));

      const rules = await call('GET', '/api/alerting/rules', { clerkId: TEAM_B_CLERK });
      assert.strictEqual(rules.status, 200);
      assert.ok(!(rules.payload.rules || []).some((r: any) => r.id === ruleId));

      const playbooks = await call('GET', '/api/playbooks/custom', { clerkId: TEAM_B_CLERK });
      assert.strictEqual(playbooks.status, 200);
      assert.ok(!(playbooks.payload.playbooks || []).some((p: any) => p.id === playbookId));

      const runs = await call('GET', '/api/remediation/runs', { clerkId: TEAM_B_CLERK });
      assert.strictEqual(runs.status, 200);
      assert.ok(!(runs.payload.runs || []).some((r: any) => r.id === runId));

      const events = await call('GET', '/api/events', { clerkId: TEAM_B_CLERK });
      assert.strictEqual(events.status, 200);
      assert.ok(!(events.payload.events || []).some((e: any) => e.id === eventId));

      const posts = await call('GET', '/api/x/posts', { clerkId: TEAM_B_CLERK });
      assert.strictEqual(posts.status, 200);
      assert.ok(!(posts.payload.posts || []).some((p: any) => p.id === postId));
    });

    it('shows a signed-in user with no membership nothing from any tenant', async () => {
      const channels = await call('GET', '/api/alerting/channels', { clerkId: LONELY_CLERK });
      assert.strictEqual(channels.status, 200);
      assert.strictEqual((channels.payload.channels || []).length, 0);

      const runs = await call('GET', '/api/remediation/runs', { clerkId: LONELY_CLERK });
      assert.strictEqual(runs.status, 200);
      assert.strictEqual((runs.payload.runs || []).length, 0);

      const playbooks = await call('GET', '/api/playbooks/custom', { clerkId: LONELY_CLERK });
      assert.strictEqual(playbooks.status, 200);
      assert.strictEqual((playbooks.payload.playbooks || []).length, 0);
    });

    it('still lets the owning tenant see and act on its own rows', async () => {
      const channels = await call('GET', '/api/alerting/channels', { clerkId: TEAM_A_CLERK });
      assert.strictEqual(channels.status, 200);
      assert.ok((channels.payload.channels || []).some((c: any) => c.id === channelId));

      const runs = await call('GET', '/api/remediation/runs', { clerkId: TEAM_A_CLERK });
      assert.strictEqual(runs.status, 200);
      assert.ok((runs.payload.runs || []).some((r: any) => r.id === runId));

      const events = await call('GET', '/api/events', { clerkId: TEAM_A_CLERK });
      assert.strictEqual(events.status, 200);
      assert.ok((events.payload.events || []).some((e: any) => e.id === eventId));
    });
  });
});
