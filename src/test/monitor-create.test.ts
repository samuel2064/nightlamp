import assert from 'assert';
import { Database } from 'sql.js';
import { Server } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { createTestToken, fetchWithoutAuth } from './setup';

const OWNER_CLERK = 'noc315-owner-clerk';
const MEMBER_CLERK = 'noc315-member-clerk';
const OTHER_CLERK = 'noc315-other-clerk';
const TEAMLESS_CLERK = 'noc315-teamless-clerk';

const EMAILS: Record<string, string> = {
  [OWNER_CLERK]: 'noc315-owner@example.com',
  [MEMBER_CLERK]: 'noc315-member@example.com',
  [OTHER_CLERK]: 'noc315-other@example.com',
  [TEAMLESS_CLERK]: 'noc315-teamless@example.com',
};

describe('NOC-315 tenant-scoped monitor creation', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;
  let otherTeamId: string;

  async function call(method: string, path: string, body?: any, clerk?: string): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (clerk) headers.Authorization = `Bearer ${createTestToken({ sub: clerk, email: EMAILS[clerk] })}`;
    const res = await fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  function createMonitor(clerk?: string, body: any = {}): Promise<{ status: number; body: any }> {
    return call('POST', '/api/monitors', body, clerk);
  }

  function countRows(where = '1=1', params: any[] = []): number {
    const result = db.exec(`SELECT COUNT(*) FROM checks WHERE ${where}`, params);
    return Number(result[0]?.values[0]?.[0] || 0);
  }

  function rowFor(id: string): any {
    const result = db.exec('SELECT id, source, name, config, enabled, team_id FROM checks WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return {
      id: row[0],
      source: row[1],
      name: row[2],
      config: JSON.parse(row[3]),
      enabled: Number(row[4]) === 1,
      teamId: row[5],
    };
  }

  before(async () => {
    db = await createDatabase();

    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc315-owner-user', OWNER_CLERK, EMAILS[OWNER_CLERK], 'NOC-315 Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc315-member-user', MEMBER_CLERK, EMAILS[MEMBER_CLERK], 'NOC-315 Member']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc315-other-user', OTHER_CLERK, EMAILS[OTHER_CLERK], 'NOC-315 Other']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc315-teamless-user', TEAMLESS_CLERK, EMAILS[TEAMLESS_CLERK], 'NOC-315 Teamless']);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'NOC-315 Team', 'noc-315-team', 'noc315-owner-user', 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, 'noc315-owner-user', 'owner']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, 'noc315-member-user', 'member']);

    otherTeamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [otherTeamId, 'NOC-315 Other Team', 'noc-315-other-team', 'noc315-other-user', 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), otherTeamId, 'noc315-other-user', 'owner']);

    server = startApiServer(db, { port: 0 });
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    if (server.listening) server.close();
    if (db) db.close();
  });

  it('rejects an anonymous monitor creation without writing a row', async () => {
    const before = countRows();
    const res = await createMonitor(undefined, { source: 'http', name: 'Anonymous App' });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(countRows(), before);
  });

  it('rejects a signed-in user without a team membership', async () => {
    const before = countRows();
    const res = await createMonitor(TEAMLESS_CLERK, { source: 'http', name: 'Teamless App' });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'FORBIDDEN');
    assert.strictEqual(countRows(), before);
  });

  it('lets a team member create a monitor owned by their own team', async () => {
    const res = await createMonitor(MEMBER_CLERK, {
      source: 'http',
      name: 'Member App',
      config: { url: 'https://member.example.com/health' },
    });

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.monitor.source, 'http');
    assert.strictEqual(res.body.monitor.name, 'Member App');
    assert.strictEqual(res.body.monitor.enabled, true);
    assert.deepStrictEqual(res.body.monitor.config, { url: 'https://member.example.com/health' });

    const row = rowFor(res.body.monitor.id);
    assert.ok(row, 'the monitor row must exist');
    assert.strictEqual(row.teamId, teamId);
    assert.strictEqual(row.source, 'http');
    assert.strictEqual(row.name, 'Member App');
    assert.deepStrictEqual(row.config, { url: 'https://member.example.com/health' });
    assert.strictEqual(row.enabled, true);
  });

  it('never writes the team id supplied in the request body', async () => {
    const own = await createMonitor(MEMBER_CLERK, {
      source: 'http',
      name: 'Own Team Body',
      teamId,
    });

    assert.strictEqual(own.status, 201, JSON.stringify(own.body));
    assert.strictEqual(rowFor(own.body.monitor.id).teamId, teamId);
  });

  it('refuses to create a monitor for another organization', async () => {
    const before = countRows();
    const res = await createMonitor(MEMBER_CLERK, {
      source: 'http',
      name: 'Foreign App',
      teamId: otherTeamId,
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'FORBIDDEN');
    assert.strictEqual(countRows(), before);
    assert.strictEqual(countRows('team_id = ?', [otherTeamId]), 0);
  });

  it('rejects invalid monitor payloads', async () => {
    const invalidPayloads: any[] = [
      { name: 'No Source' },
      { source: 'http' },
      { source: 'http', name: '   ' },
      { source: 'has spaces', name: 'Bad Source' },
      { source: '1-starts-with-digit', name: 'Bad Source' },
      { source: 'sentry', name: 'Reserved Source' },
      { source: 'uptimerobot', name: 'Reserved Source' },
      { source: 'http', name: 'Bad Config', config: 'not-an-object' },
      { source: 'http', name: 'Bad Config', config: ['array'] },
      { source: 'http', name: 'Unknown Key', orgId: otherTeamId },
      { source: 'http', name: 'Unknown Key', team_id: otherTeamId },
    ];

    const before = countRows();
    for (const payload of invalidPayloads) {
      const res = await createMonitor(MEMBER_CLERK, payload);
      assert.strictEqual(res.status, 400, `expected 400 for ${JSON.stringify(payload)}`);
      assert.strictEqual(res.body.code, 'VALIDATION_ERROR');
      assert.ok(Array.isArray(res.body.issues) && res.body.issues.length > 0);
    }
    assert.strictEqual(countRows(), before);
  });

  it('rejects a malformed JSON body', async () => {
    const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/monitors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${createTestToken({ sub: MEMBER_CLERK, email: EMAILS[MEMBER_CLERK] })}`,
      },
      body: '{not-json',
    });

    assert.strictEqual(res.status, 400);
  });

  it('lists a new monitor only for the tenant that owns it', async () => {
    const created = await createMonitor(MEMBER_CLERK, { source: 'tcp', name: 'Scoped App' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const monitorId = created.body.monitor.id;

    const own = await call('GET', '/api/monitors', undefined, MEMBER_CLERK);
    assert.strictEqual(own.status, 200);
    assert.ok(own.body.monitors.some((monitor: any) => monitor.id === monitorId));

    const foreign = await call('GET', '/api/monitors', undefined, OTHER_CLERK);
    assert.strictEqual(foreign.status, 200);
    assert.ok(!foreign.body.monitors.some((monitor: any) => monitor.id === monitorId));
  });

  it('invalidates the cached monitor list after a creation', async () => {
    const first = await call('GET', '/api/monitors', undefined, MEMBER_CLERK);
    assert.strictEqual(first.status, 200);
    const beforeIds = first.body.monitors.map((monitor: any) => monitor.id);

    const created = await createMonitor(MEMBER_CLERK, { source: 'http', name: 'Cache Invalidation App' });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));

    const second = await call('GET', '/api/monitors', undefined, MEMBER_CLERK);
    const afterIds = second.body.monitors.map((monitor: any) => monitor.id);
    assert.ok(!beforeIds.includes(created.body.monitor.id));
    assert.ok(afterIds.includes(created.body.monitor.id));
  });

  it('rejects an oversized monitor payload', async () => {
    const before = countRows();
    const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/monitors`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${createTestToken({ sub: MEMBER_CLERK, email: EMAILS[MEMBER_CLERK] })}`,
      },
      body: JSON.stringify({ source: 'http', name: 'Large App', config: { padding: 'x'.repeat(70 * 1024) } }),
    });

    assert.strictEqual(res.status, 413);
    assert.strictEqual(countRows(), before);
  });
});
