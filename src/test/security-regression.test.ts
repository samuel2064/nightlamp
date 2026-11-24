import assert from 'assert';
import { Server } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { startApiServer } from '../api/server';
import { initEngine, setDb } from '../remediation/engine';
import { createDatabase } from '../db/schema';
import { createTestToken, fetchWithoutAuth } from './setup';

type TestIdentity = {
  userId: string;
  clerkId: string;
  marker: string;
};

type TestRequest = {
  method?: string;
  body?: unknown;
};

describe('P0 security regression gate', () => {
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
  const originalIssuer = process.env.CLERK_JWT_ISSUER;
  const originalAudience = process.env.CLERK_JWT_AUDIENCE;

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
    delete process.env.CLERK_JWT_ISSUER;
    delete process.env.CLERK_JWT_AUDIENCE;
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

    server = startApiServer(db, { port: 0 });
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    if (server?.listening) server.close();
    if (db) db.close();
    if (originalIssuer === undefined) delete process.env.CLERK_JWT_ISSUER;
    else process.env.CLERK_JWT_ISSUER = originalIssuer;
    if (originalAudience === undefined) delete process.env.CLERK_JWT_AUDIENCE;
    else process.env.CLERK_JWT_AUDIENCE = originalAudience;
  });

  describe('anonymous deny-by-default gate', () => {
    const privateRoutes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/events' },
      { method: 'GET', path: '/api/teams' },
      { method: 'GET', path: '/api/teams/security-regression/members' },
      { method: 'GET', path: '/api/check-results' },
      { method: 'GET', path: '/api/remediation/runs' },
      { method: 'GET', path: '/api/dependencies' },
      { method: 'GET', path: '/api/alerting/rules' },
      { method: 'GET', path: '/api/apps' },
      { method: 'GET', path: '/api/playbook/executions' },
      { method: 'GET', path: '/api/billing/portal' },
      { method: 'POST', path: '/api/remediation/approve', body: {} },
      { method: 'POST', path: '/api/onboarding/security-regression/complete', body: {} },
      { method: 'POST', path: '/api/apps/security-regression/test-check', body: {} },
      { method: 'GET', path: '/api/realtime' },
      { method: 'GET', path: '/api/stream' },
      { method: 'GET', path: '/api/trpc/health.status' },
    ];

    for (const route of privateRoutes) {
      it(`answers 401 for anonymous ${route.method} ${route.path}`, async () => {
        const res = await fetchWithoutAuth(`http://127.0.0.1:${port}${route.path}`, {
          method: route.method,
          ...(route.body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(route.body) }),
        });
        assert.strictEqual(res.status, 401);
        const body = await res.json() as any;
        assert.strictEqual(body.code, 'UNAUTHORIZED');
      });
    }

    it('keeps the health endpoint public', async () => {
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(res.status, 200);
    });
  });

  describe('session verification', () => {
    it('answers 401 for an expired session', async () => {
      const token = tokenFor(ownerA, { exp: Math.floor(Date.now() / 1000) - 120 });
      const res = await requestWithToken(token, '/api/events');
      assert.strictEqual(res.status, 401);
    });

    it('answers 401 for an invalid signature', async () => {
      const token = createTestToken(
        { sub: ownerA.clerkId, email: ownerA.marker },
        uuidv4(),
      );
      const res = await requestWithToken(token, '/api/events');
      assert.strictEqual(res.status, 401);
    });

    it('answers 401 for a token minted for another issuer', async () => {
      process.env.CLERK_JWT_ISSUER = 'https://issuer.invalid';
      try {
        const token = tokenFor(ownerA, { iss: 'https://other-issuer.invalid' });
        const res = await requestWithToken(token, '/api/events');
        assert.strictEqual(res.status, 401);
      } finally {
        delete process.env.CLERK_JWT_ISSUER;
      }
    });

    it('accepts a valid token without an audience claim', async () => {
      const res = await request(ownerA, '/api/events');
      assert.strictEqual(res.status, 200);
    });
  });

  describe('team and invitation ownership', () => {
    it('binds a newly created team and owner membership to the authenticated principal', async () => {
      const suffix = uuidv4();
      const res = await request(creator, '/api/teams', {
        method: 'POST',
        body: { name: `team-${suffix}`, slug: `team-${suffix}` },
      });
      const text = await res.text();
      assert.strictEqual(res.status, 200, text);
      const body = JSON.parse(text);
      assert.strictEqual(scalar('SELECT owner_id FROM teams WHERE id = ?', [body.id]), creator.userId);
      assert.strictEqual(
        scalar('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?', [body.id, creator.userId]),
        'owner',
      );
    });

    it('rejects a client-supplied owner from another organisation', async () => {
      const suffix = uuidv4();
      const res = await request(creator, '/api/teams', {
        method: 'POST',
        body: { name: `team-${suffix}`, slug: `team-${suffix}`, ownerId: ownerB.userId },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM teams WHERE slug = ?', [`team-${suffix}`]), 0);
    });

    it('answers 401 for an unauthenticated invitation acceptance', async () => {
      const invitationId = uuidv4();
      const invitationToken = uuidv4();
      db.run(
        'INSERT INTO invitations (id, team_id, email, role, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [invitationId, teamAId, invitee.marker, 'member', invitationToken, '2099-01-01T00:00:00.000Z'],
      );
      const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/invitations/${invitationToken}/accept`, {
        method: 'POST',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM memberships WHERE team_id = ?', [teamAId]), 2);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM invitations WHERE id = ?', [invitationId]), 1);
    });

    it('binds an authenticated invitation acceptance to the accepting principal', async () => {
      const invitationId = uuidv4();
      const invitationToken = uuidv4();
      db.run(
        'INSERT INTO invitations (id, team_id, email, role, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        [invitationId, teamAId, invitee.marker, 'member', invitationToken, '2099-01-01T00:00:00.000Z'],
      );
      const res = await request(invitee, `/api/invitations/${invitationToken}/accept`, { method: 'POST' });
      const text = await res.text();
      assert.strictEqual(res.status, 200, text);
      assert.strictEqual(
        scalar('SELECT user_id FROM memberships WHERE team_id = ? AND user_id = ?', [teamAId, invitee.userId]),
        invitee.userId,
      );
      assert.strictEqual(scalar('SELECT COUNT(*) FROM invitations WHERE id = ?', [invitationId]), 0);
    });
  });

  describe('cross-organisation isolation', () => {
    it('does not read another organisation event rows', async () => {
      const res = await request(ownerB, '/api/events');
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(!body.events.some((event: any) => event.id === eventAId));
    });

    it('does not read another organisation dependency rows', async () => {
      const res = await request(ownerB, '/api/dependencies');
      assert.strictEqual(res.status, 200);
      const body = await res.json() as any;
      assert.ok(!body.dependencies.some((dependency: any) => dependency.id === dependencyAId));
    });

    it('does not acknowledge another organisation event', async () => {
      const res = await request(ownerB, '/api/events/acknowledge', {
        method: 'POST',
        body: { id: eventAId },
      });
      // A foreign target is indistinguishable from an absent one (NOC-342):
      // the same status and the same body bytes.
      assert.strictEqual(res.status, 404);
      assert.strictEqual(scalar('SELECT acknowledged FROM failure_events WHERE id = ?', [eventAId]), 0);
      const absent = await request(ownerB, '/api/events/acknowledge', {
        method: 'POST',
        body: { id: 'absent-event-id' },
      });
      assert.strictEqual(absent.status, 404);
      assert.strictEqual(await res.text(), await absent.text());
    });

    it('does not mutate another organisation alert channel', async () => {
      const res = await request(ownerB, `/api/alerting/channels/${channelAId}`, { method: 'DELETE' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM alert_channels WHERE id = ?', [channelAId]), 1);
    });

    it('does not mutate another organisation workspace', async () => {
      const res = await request(ownerB, `/api/teams/${teamAId}/workspace`, {
        method: 'PATCH',
        body: { settings: { marker: 'changed' } },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(
        scalar('SELECT settings FROM team_workspaces WHERE team_id = ?', [teamAId]),
        JSON.stringify({ marker: 'original' }),
      );
    });

    it('does not approve another organisation remediation run', async () => {
      const res = await request(ownerB, '/api/remediation/approve', {
        method: 'POST',
        body: { id: runAId },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(scalar('SELECT status FROM remediation_runs WHERE id = ?', [runAId]), 'pending');
    });
  });

  describe('privileged mutation enforcement', () => {
    it('answers 403 when a member attempts self-promotion', async () => {
      const res = await request(member, `/api/teams/${teamAId}/members/${member.userId}`, {
        method: 'PATCH',
        body: { role: 'owner' },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(
        scalar('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?', [teamAId, member.userId]),
        'member',
      );
    });

    it('answers 403 when a member attempts an administrative mutation', async () => {
      const before = scalar('SELECT COUNT(*) FROM alert_channels');
      const res = await request(member, '/api/alerting/channels', {
        method: 'POST',
        body: { name: `channel-${uuidv4()}`, type: 'slack', config: {} },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(scalar('SELECT COUNT(*) FROM alert_channels'), before);
    });

    it('answers 403 when a member attempts remediation approval', async () => {
      const res = await request(member, '/api/remediation/approve', {
        method: 'POST',
        body: { id: runAId },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(scalar('SELECT status FROM remediation_runs WHERE id = ?', [runAId]), 'pending');
    });
  });

  describe('fail-closed tenant scope', () => {
    const tenantOwnedRoutes = [
      '/api/events',
      '/api/check-results',
      '/api/monitors',
      '/api/dependencies',
      '/api/remediation/runs',
      '/api/alerting/channels',
      '/api/alerting/rules',
    ];

    for (const path of tenantOwnedRoutes) {
      it(`answers 403 for a teamless caller on ${path}`, async () => {
        const res = await request(lonely, path);
        assert.strictEqual(res.status, 403);
        const body = await res.json() as any;
        assert.strictEqual(body.code, 'FORBIDDEN');
      });
    }

    it('never exposes an unscoped legacy row to a teamless caller', async () => {
      const res = await request(lonely, '/api/events');
      const text = await res.text();
      assert.strictEqual(res.status, 403);
      assert.ok(!text.includes(legacyEventId));
    });

    it('answers 403 when a teamless caller acknowledges a known event', async () => {
      const res = await request(lonely, '/api/events/acknowledge', {
        method: 'POST',
        body: { id: legacyEventId },
      });
      assert.strictEqual(res.status, 403);
      assert.strictEqual(scalar('SELECT acknowledged FROM failure_events WHERE id = ?', [legacyEventId]), 0);
    });

    it('answers 404 when a teamless caller acknowledges an unknown event', async () => {
      const res = await request(lonely, '/api/events/acknowledge', {
        method: 'POST',
        body: { id: uuidv4() },
      });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('remediation approval truthfulness', () => {
    it('rejects an unknown action without stranding the run', async () => {
      const runId = uuidv4();
      const entryId = uuidv4();
      const actionName = `unknown-${uuidv4()}`;
      db.run('INSERT INTO playbook_entries (id, failure_type, title, body, team_id) VALUES (?, ?, ?, ?, ?)', [
        entryId, 'broken_webhook', `entry-${uuidv4()}`, 'fixture', teamAId,
      ]);
      db.run('INSERT INTO remediation_runs (id, playbook_entry_id, action_name, status, team_id) VALUES (?, ?, ?, ?, ?)', [
        runId, entryId, actionName, 'pending', teamAId,
      ]);
      const res = await request(ownerA, '/api/remediation/approve', {
        method: 'POST',
        body: { id: runId },
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(scalar('SELECT status FROM remediation_runs WHERE id = ?', [runId]), 'failed');
      assert.strictEqual(scalar('SELECT started_at FROM remediation_runs WHERE id = ?', [runId]), null);
      assert.notStrictEqual(scalar('SELECT completed_at FROM remediation_runs WHERE id = ?', [runId]), null);
    });
  });
});
