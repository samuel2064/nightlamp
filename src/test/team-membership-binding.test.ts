import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';

const OWNER_CLERK = 'noc294-owner-clerk';
const MEMBER_CLERK = 'noc294-member-clerk';
const LONELY_CLERK = 'noc294-lonely-clerk';
const OTHER_LONELY_CLERK = 'noc294-other-lonely-clerk';
const SECOND_MEMBER_CLERK = 'noc294-second-member-clerk';
const INVITEE_CLERK = 'noc294-invitee-clerk';

const EMAILS: Record<string, string> = {
  [OWNER_CLERK]: 'noc294-owner@example.com',
  [MEMBER_CLERK]: 'noc294-member@example.com',
  [LONELY_CLERK]: 'noc294-lonely@example.com',
  [OTHER_LONELY_CLERK]: 'noc294-other-lonely@example.com',
  [SECOND_MEMBER_CLERK]: 'noc294-second-member@example.com',
  [INVITEE_CLERK]: 'noc294-invitee@example.com',
};

describe('NOC-294 team membership binding and fail-closed scoping', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;

  async function call(clerkId: string, path: string, init: any = {}, teamId?: string): Promise<{ status: number; body: any }> {
    const headers = new Headers(init.headers || {});
    headers.set('authorization', 'Bearer ' + createTestToken({ sub: clerkId, email: EMAILS[clerkId] }));
    if (teamId) headers.set('x-nightlamp-team-id', teamId);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const res = await fetchWithoutAuth('http://127.0.0.1:' + port + path, Object.assign({}, init, { headers }));
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  function internalUserId(clerkId: string): string {
    const result = db.exec('SELECT id FROM users WHERE clerk_user_id = ?', [clerkId]);
    assert.ok(result.length > 0 && result[0].values.length > 0, 'the identity must exist');
    return result[0].values[0][0] as string;
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner@example.com', 'Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc294-owner-user', OWNER_CLERK, 'noc294-owner@example.com', 'NOC-294 Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc294-member-user', MEMBER_CLERK, 'noc294-member@example.com', 'NOC-294 Member']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc294-lonely-user', LONELY_CLERK, 'noc294-lonely@example.com', 'NOC-294 Lonely']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc294-other-lonely-user', OTHER_LONELY_CLERK, 'noc294-other-lonely@example.com', 'NOC-294 Other Lonely']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc294-second-member-user', SECOND_MEMBER_CLERK, 'noc294-second-member@example.com', 'NOC-294 Second Member']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc294-invitee-user', INVITEE_CLERK, 'noc294-invitee@example.com', 'NOC-294 Invitee']);
    server = startApiServer(db, { port: 0 });
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    if (server.listening) server.close();
    if (db) db.close();
  });

  describe('team creation binds the authenticated user', () => {
    it('stores the authenticated user as the owner and creates the owner membership', async () => {
      const res = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-294 Team', slug: 'noc-294-team' }),
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.success, true);

      const ownerId = internalUserId(OWNER_CLERK);
      assert.strictEqual(res.body.ownerId, ownerId);

      const team = db.exec('SELECT owner_id FROM teams WHERE id = ?', [res.body.id]);
      assert.strictEqual(team[0].values[0][0], ownerId);

      const membership = db.exec('SELECT user_id, role FROM memberships WHERE team_id = ?', [res.body.id]);
      assert.strictEqual(membership[0].values.length, 1);
      assert.strictEqual(membership[0].values[0][0], ownerId);
      assert.strictEqual(membership[0].values[0][1], 'owner');
    });

    it('rejects a client supplied ownerId that is not the authenticated user', async () => {
      const res = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'Hijacked Team', slug: 'noc-294-hijacked', ownerId: internalUserId(OTHER_LONELY_CLERK) }),
      });
      assert.strictEqual(res.status, 403);
      const teams = db.exec("SELECT COUNT(*) FROM teams WHERE slug = 'noc-294-hijacked'");
      assert.strictEqual(teams[0].values[0][0], 0);
    });

    it('requires authentication to create a team', async () => {
      const res = await fetchWithoutAuth('http://127.0.0.1:' + port + '/api/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Anonymous Team', slug: 'noc-294-anonymous' }),
      });
      assert.strictEqual(res.status, 401);
      const teams = db.exec("SELECT COUNT(*) FROM teams WHERE slug = 'noc-294-anonymous'");
      assert.strictEqual(teams[0].values[0][0], 0);
    });
  });

  describe('membership resolution', () => {
    before(async () => {
      const res = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-294 Members Team', slug: 'noc-294-members-team' }),
      });
      teamId = res.body.id;
    });

    it('resolves a member from an existing account', async () => {
      const res = await call(OWNER_CLERK, '/api/teams/' + teamId + '/members', {
        method: 'POST',
        body: JSON.stringify({ userId: internalUserId(MEMBER_CLERK), role: 'member' }),
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.userId, internalUserId(MEMBER_CLERK));
    });

    it('resolves a member by email', async () => {
      const res = await call(OWNER_CLERK, '/api/teams/' + teamId + '/members', {
        method: 'POST',
        body: JSON.stringify({ email: 'noc294-second-member@example.com', role: 'member' }),
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.userId, internalUserId(SECOND_MEMBER_CLERK));
    });

    it('refuses a user id without an account', async () => {
      const res = await call(OWNER_CLERK, '/api/teams/' + teamId + '/members', {
        method: 'POST',
        body: JSON.stringify({ userId: 'planted-noc294-user' }),
      });
      assert.strictEqual(res.status, 404);
      const members = db.exec('SELECT COUNT(*) FROM memberships WHERE team_id = ? AND user_id = ?', [teamId, 'planted-noc294-user']);
      assert.strictEqual(members[0].values[0][0], 0);
    });

    it('refuses an email without an account', async () => {
      const res = await call(OWNER_CLERK, '/api/teams/' + teamId + '/members', {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody-noc294@example.com' }),
      });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('invitation acceptance binds the authenticated user', () => {
    it('creates the membership for the accepting identity, not for the invited address', async () => {
      const team = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-294 Invite Team', slug: 'noc-294-invite-team' }),
      });
      const invitation = await call(OWNER_CLERK, '/api/teams/' + team.body.id + '/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'noc294-invitee@example.com', role: 'member' }),
      });
      assert.strictEqual(invitation.status, 200, JSON.stringify(invitation.body));

      const accepted = await call(INVITEE_CLERK, '/api/invitations/' + invitation.body.token + '/accept', { method: 'POST' });
      assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
      assert.strictEqual(accepted.body.userId, internalUserId(INVITEE_CLERK));

      const memberships = db.exec('SELECT user_id FROM memberships WHERE team_id = ?', [team.body.id]);
      const userIds = memberships[0].values.map((row: any) => row[0]);
      assert.ok(userIds.includes(internalUserId(INVITEE_CLERK)));
      assert.ok(!userIds.includes('noc294-invitee@example.com'));
    });
  });

  describe('onboarding completion binds the authenticated user', () => {
    it('creates the team with the caller as owner and inserts the owner membership', async () => {
      const ownerId = internalUserId(MEMBER_CLERK);
      const start = await call(MEMBER_CLERK, '/api/onboarding/start', {
        method: 'POST',
        body: JSON.stringify({ userId: ownerId }),
      });
      assert.strictEqual(start.status, 200, JSON.stringify(start.body));
      const sessionId = start.body.sessionId;

      for (const step of ['monitor-selection', 'alert-config', 'team-invite']) {
        const advanced = await call(MEMBER_CLERK, '/api/onboarding/' + sessionId + '/step', {
          method: 'POST',
          body: JSON.stringify({ step, data: {} }),
        });
        assert.strictEqual(advanced.status, 200, JSON.stringify(advanced.body));
      }

      const completed = await call(MEMBER_CLERK, '/api/onboarding/' + sessionId + '/complete', { method: 'POST' });
      assert.strictEqual(completed.status, 200, JSON.stringify(completed.body));

      const team = db.exec('SELECT owner_id FROM teams WHERE id = ?', [completed.body.teamId]);
      assert.strictEqual(team[0].values[0][0], ownerId);

      const membership = db.exec('SELECT user_id, role FROM memberships WHERE team_id = ?', [completed.body.teamId]);
      assert.strictEqual(membership[0].values.length, 1);
      assert.strictEqual(membership[0].values[0][0], ownerId);
      assert.strictEqual(membership[0].values[0][1], 'owner');
    });
  });

  describe('teamless callers fail closed', () => {
    let testTeamId: string;

    before(async () => {
      const res = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-294 Test Team', slug: 'noc-294-test-team' }),
      });
      testTeamId = res.body.id;
    });

    it('answers 403 on the monitoring routes', async () => {
      for (const path of ['/api/events', '/api/check-results', '/api/remediation/runs', '/api/dependencies', '/api/dependencies/updates']) {
        const res = await call(LONELY_CLERK, path);
        assert.strictEqual(res.status, 403, path + ' -> ' + JSON.stringify(res.body));
        assert.strictEqual(res.body.code, 'FORBIDDEN');
      }
    });

    it('never acknowledges an event for a teamless caller', async () => {
      const checkId = uuidv4();
      const eventId = uuidv4();
      db.run('INSERT INTO checks (id, source, name, config, team_id) VALUES (?, ?, ?, ?, NULL)',
        [checkId, 'http', 'Teamless check', '{}']);
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, ?, 'broken_webhook', 'warning', 'Teamless failure', NULL)`, [eventId, checkId]);

      const known = await call(LONELY_CLERK, '/api/events/acknowledge', {
        method: 'POST',
        body: JSON.stringify({ id: eventId }),
      });
      assert.strictEqual(known.status, 403);

      const unknown = await call(LONELY_CLERK, '/api/events/acknowledge', {
        method: 'POST',
        body: JSON.stringify({ id: 'noc294-unknown-event' }),
      });
      assert.strictEqual(unknown.status, 404);
    });

    it('keeps team-scoped identities out of each other rows', async () => {
      const channelId = uuidv4();
      db.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, ?)',
        [channelId, 'NOC-294 team channel', 'in-app-websocket', '{}', testTeamId]);

      const owner = await call(OWNER_CLERK, '/api/alerting/channels', {}, testTeamId);
      assert.ok(owner.body.channels.some((ch: any) => ch.id === channelId));
    });

    it('hides legacy rows that carry no team from a teamless caller', async () => {
      const channelId = uuidv4();
      db.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, NULL)',
        [channelId, 'NOC-294 legacy channel', 'in-app-websocket', '{}']);

      const list = await call(LONELY_CLERK, '/api/alerting/channels');
      assert.strictEqual(list.status, 403);
      assert.strictEqual(list.body.code, 'FORBIDDEN');

      const read = await call(LONELY_CLERK, '/api/alerting/channels/' + channelId);
      assert.strictEqual(read.status, 404);
    });

    it('hides tenant rows that carry no team from a teamless caller', async () => {
      const eventId = uuidv4();
      const checkId = uuidv4();
      db.run('INSERT INTO checks (id, source, name, config, team_id) VALUES (?, ?, ?, ?, NULL)',
        [checkId, 'http', 'Legacy check', '{}']);
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, ?, 'broken_webhook', 'warning', 'Legacy failure', NULL)`, [eventId, checkId]);

      const events = await call(LONELY_CLERK, '/api/events');
      assert.strictEqual(events.status, 403);

      const acknowledged = await call(LONELY_CLERK, '/api/events/acknowledge', {
        method: 'POST',
        body: JSON.stringify({ id: eventId }),
      });
      assert.strictEqual(acknowledged.status, 403);

      const row = db.exec('SELECT acknowledged FROM failure_events WHERE id = ?', [eventId]);
      assert.strictEqual(row[0].values[0][0], 0);
    });

    it('answers 403 for a teamless caller on POST /api/alerting/rules', async () => {
      const res = await call(LONELY_CLERK, '/api/alerting/rules', {
        method: 'POST',
        body: { checkId: uuidv4(), channelId: uuidv4(), ruleType: 'threshold', config: {} },
      });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, 'FORBIDDEN');
    });
  });
});