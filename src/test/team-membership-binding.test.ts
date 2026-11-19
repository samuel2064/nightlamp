import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';
import { cleanupVerificationTeams, VERIFICATION_TEAM_PREFIX } from '../../scripts/cleanup-verification-teams';
import { evaluateAndNotify } from '../alerting/evaluator';

const OWNER_CLERK = 'noc319-owner-clerk';
const MEMBER_CLERK = 'noc319-member-clerk';
const LONELY_CLERK = 'noc319-lonely-clerk';
const OTHER_LONELY_CLERK = 'noc319-other-lonely-clerk';
const SECOND_MEMBER_CLERK = 'noc319-second-member-clerk';
const INVITEE_CLERK = 'noc319-invitee-clerk';

const EMAILS: Record<string, string> = {
  [OWNER_CLERK]: 'noc319-owner@example.com',
  [MEMBER_CLERK]: 'noc319-member@example.com',
  [LONELY_CLERK]: 'noc319-lonely@example.com',
  [OTHER_LONELY_CLERK]: 'noc319-other-lonely@example.com',
  [SECOND_MEMBER_CLERK]: 'noc319-second-member@example.com',
  [INVITEE_CLERK]: 'noc319-invitee@example.com',
};

describe('NOC-319 team membership binding and fail-closed scoping', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;

  async function call(clerkId: string, path: string, init: any = {}): Promise<{ status: number; body: any }> {
    const headers = new Headers(init.headers || {});
    headers.set('authorization', 'Bearer ' + createTestToken({ sub: clerkId, email: EMAILS[clerkId] }));
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
      ['noc319-owner-user', OWNER_CLERK, 'noc319-owner@example.com', 'NOC-319 Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc319-member-user', MEMBER_CLERK, 'noc319-member@example.com', 'NOC-319 Member']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc319-lonely-user', LONELY_CLERK, 'noc319-lonely@example.com', 'NOC-319 Lonely']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc319-other-lonely-user', OTHER_LONELY_CLERK, 'noc319-other-lonely@example.com', 'NOC-319 Other Lonely']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc319-second-member-user', SECOND_MEMBER_CLERK, 'noc319-second-member@example.com', 'NOC-319 Second Member']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['noc319-invitee-user', INVITEE_CLERK, 'noc319-invitee@example.com', 'NOC-319 Invitee']);
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
        body: JSON.stringify({ name: 'NOC-319 Team', slug: 'noc-319-team' }),
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
        body: JSON.stringify({ name: 'Hijacked Team', slug: 'noc-319-hijacked', ownerId: internalUserId(OTHER_LONELY_CLERK) }),
      });
      assert.strictEqual(res.status, 403);
      const teams = db.exec("SELECT COUNT(*) FROM teams WHERE slug = 'noc-319-hijacked'");
      assert.strictEqual(teams[0].values[0][0], 0);
    });

    it('requires authentication to create a team', async () => {
      const res = await fetchWithoutAuth('http://127.0.0.1:' + port + '/api/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Anonymous Team', slug: 'noc-319-anonymous' }),
      });
      assert.strictEqual(res.status, 401);
      const teams = db.exec("SELECT COUNT(*) FROM teams WHERE slug = 'noc-319-anonymous'");
      assert.strictEqual(teams[0].values[0][0], 0);
    });
  });

  describe('membership resolution', () => {
    before(async () => {
      const res = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-319 Members Team', slug: 'noc-319-members-team' }),
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
        body: JSON.stringify({ email: 'noc319-second-member@example.com', role: 'member' }),
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.userId, internalUserId(SECOND_MEMBER_CLERK));
    });

    it('refuses a user id without an account', async () => {
      const res = await call(OWNER_CLERK, '/api/teams/' + teamId + '/members', {
        method: 'POST',
        body: JSON.stringify({ userId: 'planted-noc319-user' }),
      });
      assert.strictEqual(res.status, 404);
      const members = db.exec('SELECT COUNT(*) FROM memberships WHERE team_id = ? AND user_id = ?', [teamId, 'planted-noc319-user']);
      assert.strictEqual(members[0].values[0][0], 0);
    });

    it('refuses an email without an account', async () => {
      const res = await call(OWNER_CLERK, '/api/teams/' + teamId + '/members', {
        method: 'POST',
        body: JSON.stringify({ email: 'nobody-noc319@example.com' }),
      });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('invitation acceptance binds the authenticated user', () => {
    it('creates the membership for the accepting identity, not for the invited address', async () => {
      const team = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-319 Invite Team', slug: 'noc-319-invite-team' }),
      });
      const invitation = await call(OWNER_CLERK, '/api/teams/' + team.body.id + '/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'noc319-invitee@example.com', role: 'member' }),
      });
      assert.strictEqual(invitation.status, 200, JSON.stringify(invitation.body));

      const accepted = await call(INVITEE_CLERK, '/api/invitations/' + invitation.body.token + '/accept', { method: 'POST' });
      assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
      assert.strictEqual(accepted.body.userId, internalUserId(INVITEE_CLERK));

      const memberships = db.exec('SELECT user_id FROM memberships WHERE team_id = ?', [team.body.id]);
      const userIds = memberships[0].values.map((row: any) => row[0]);
      assert.ok(userIds.includes(internalUserId(INVITEE_CLERK)));
      assert.ok(!userIds.includes('noc319-invitee@example.com'));
    });
  });

  describe('teamless callers fail closed', () => {
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
        body: JSON.stringify({ id: 'noc319-unknown-event' }),
      });
      assert.strictEqual(unknown.status, 404);
    });

    it('keeps the unscoped monitoring bucket closed to every teamless identity', async () => {
      // main has no owner column, so the unscoped bucket cannot be split per
      // user: it is closed to everyone instead of leaking across identities.
      const checkId = uuidv4();
      const eventId = uuidv4();
      db.run('INSERT INTO checks (id, source, name, config, team_id) VALUES (?, ?, ?, ?, NULL)',
        [checkId, 'http', 'Unscoped check', '{}']);
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, ?, 'broken_webhook', 'warning', 'Unscoped failure', NULL)`, [eventId, checkId]);

      for (const clerkId of [LONELY_CLERK, OTHER_LONELY_CLERK]) {
        for (const path of ['/api/events', '/api/incidents', '/api/monitors', '/api/activity']) {
          const res = await call(clerkId, path);
          assert.strictEqual(res.status, 403, clerkId + ' ' + path + ' -> ' + JSON.stringify(res.body));
          assert.strictEqual(res.body.code, 'FORBIDDEN', path);
        }
      }

      const row = db.exec('SELECT acknowledged FROM failure_events WHERE id = ?', [eventId]);
      assert.strictEqual(row[0].values[0][0], 0);
    });

    it('hides unscoped alert channels from a teamless caller and never deletes them', async () => {
      const channelId = uuidv4();
      db.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, NULL)',
        [channelId, 'NOC-319 legacy channel', 'in-app-websocket', '{}']);

      const list = await call(LONELY_CLERK, '/api/alerting/channels');
      assert.strictEqual(list.status, 403);
      assert.strictEqual(list.body.code, 'FORBIDDEN');
      assert.ok(!(list.body.channels || []).some((channel: any) => channel.id === channelId));

      // A teamless identity has no team role, so the admin gate refuses the
      // mutation before any scope check; either refusal is acceptable as long
      // as the row survives.
      const remove = await call(LONELY_CLERK, '/api/alerting/channels/' + channelId, { method: 'DELETE' });
      assert.ok(remove.status === 403 || remove.status === 404, 'unexpected status ' + remove.status);

      const row = db.exec('SELECT id FROM alert_channels WHERE id = ?', [channelId]);
      assert.ok(row.length > 0 && row[0].values.length > 0, 'the unscoped row must survive');
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

  it('answers 403 on /api/playbook/match for a caller with no membership', async () => {
      assert.ok(teamId, 'a tenant exists to plant owned rows against');
      const ownedPlaybookId = uuidv4();
      const sharedPlaybookId = uuidv4();
      db.run(`INSERT INTO playbook_entries (id, failure_type, title, body, first_seen_at, last_occurrence_at, occurrence_count, team_id)
              VALUES (?, 'expired_token', 'Owned token playbook', 'token symptoms', datetime('now'), datetime('now'), 1, ?)`,
        [ownedPlaybookId, teamId]);
      db.run(`INSERT INTO playbook_entries (id, failure_type, title, body, first_seen_at, last_occurrence_at, occurrence_count, team_id)
              VALUES (?, 'expired_token', 'Shared token playbook', 'token symptoms', datetime('now'), datetime('now'), 1, NULL)`,
        [sharedPlaybookId]);

      const res = await call(LONELY_CLERK, '/api/playbook/match?symptoms=token');
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, 'FORBIDDEN');
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(ownedPlaybookId), 'the body must carry no owned row');
      assert.ok(!serialized.includes(sharedPlaybookId), 'the body must carry no unscoped row');
    });

    it('answers 403 on /api/playbook/correlations for a caller with no membership', async () => {
      const ownedEventId = uuidv4();
      const sharedEventId = uuidv4();
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, 'check-1', 'expired_token', 'critical', 'Owned token failure', ?)`, [ownedEventId, teamId]);
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, 'check-1', 'expired_token', 'critical', 'Shared token failure', NULL)`, [sharedEventId]);

      const res = await call(LONELY_CLERK, '/api/playbook/correlations?failureType=expired_token');
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, 'FORBIDDEN');
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(ownedEventId), 'the body must carry no owned row');
      assert.ok(!serialized.includes(sharedEventId), 'the body must carry no unscoped row');
    });

    it('answers 403 on /api/reports/incident-trends for a caller with no membership', async () => {
      const ownedEventId = uuidv4();
      const sharedEventId = uuidv4();
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, 'check-1', 'expired_token', 'critical', 'Owned report failure', ?)`, [ownedEventId, teamId]);
      db.run(`INSERT INTO failure_events (id, check_id, failure_type, severity, title, team_id)
              VALUES (?, 'check-1', 'expired_token', 'critical', 'Shared report failure', NULL)`, [sharedEventId]);

      const res = await call(LONELY_CLERK, '/api/reports/incident-trends');
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, 'FORBIDDEN');
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes(ownedEventId), 'the body must carry no owned row');
      assert.ok(!serialized.includes(sharedEventId), 'the body must carry no unscoped row');
    });
  });

  describe('the remaining mutation and background paths fail closed for a teamless caller', () => {
    it('answers 403 on /api/notifications/send when no membership exists', async () => {
      const sharedChannelId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Unscoped Channel', 'slack', ?, NULL)`,
        [sharedChannelId, JSON.stringify({ webhookUrl: 'https://hooks.example.com/services/unused' })],
      );

      const res = await call(LONELY_CLERK, '/api/notifications/send', {
        method: 'POST',
        body: JSON.stringify({ channelId: sharedChannelId, title: 'Teamless send', failureType: 'expired_token', severity: 'critical' }),
      });
      assert.strictEqual(res.status, 403, JSON.stringify(res.body));
      assert.strictEqual(res.body.code, 'FORBIDDEN');
      const logs = db.exec('SELECT COUNT(*) FROM alert_log WHERE channel_id = ?', [sharedChannelId]);
      assert.strictEqual(logs[0].values[0][0], 0);
    });

    it('refuses an onboarding session addressed to another user', async () => {
      const foreignUserId = internalUserId(OWNER_CLERK);
      const start = await call(LONELY_CLERK, '/api/onboarding/start', {
        method: 'POST',
        body: JSON.stringify({ userId: foreignUserId }),
      });
      assert.strictEqual(start.status, 403, JSON.stringify(start.body));
      const sessions = db.exec('SELECT COUNT(*) FROM onboarding_sessions WHERE user_id = ?', [foreignUserId]);
      assert.strictEqual(sessions[0].values[0][0], 0);
    });

    it('hides another user onboarding session from status and step', async () => {
      const mine = await call(OTHER_LONELY_CLERK, '/api/onboarding/start', {
        method: 'POST',
        body: JSON.stringify({ userId: internalUserId(OTHER_LONELY_CLERK) }),
      });
      assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
      const sessionId = mine.body.sessionId as string;

      const foreignStatus = await call(LONELY_CLERK, `/api/onboarding/${sessionId}/status`);
      assert.strictEqual(foreignStatus.status, 404);

      const foreignStep = await call(LONELY_CLERK, `/api/onboarding/${sessionId}/step`, {
        method: 'POST',
        body: JSON.stringify({ step: 'monitor-selection', data: {} }),
      });
      assert.strictEqual(foreignStep.status, 404);

      const ownStatus = await call(OTHER_LONELY_CLERK, `/api/onboarding/${sessionId}/status`);
      assert.strictEqual(ownStatus.status, 200);
      assert.strictEqual(ownStatus.body.session.id, sessionId);
    });

    it('delivers no alert for an event that resolves to no team', async () => {
      const channelId = uuidv4();
      const ruleId = uuidv4();
      const eventId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Unscoped Eval Channel', 'slack', ?, NULL)`,
        [channelId, JSON.stringify({ webhookUrl: 'https://hooks.example.com/services/unused' })],
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, team_id) VALUES (?, 'Unscoped Eval Rule', ?, ?, 'info', NULL)`,
        [ruleId, channelId, JSON.stringify(['noc319_eval_type'])],
      );
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, detected_at, team_id)
         VALUES (?, 'noc319-check-2', 'noc319_eval_type', 'warning', 'Teamless event', 'teamless', datetime('now'), NULL)`,
        [eventId],
      );

      await evaluateAndNotify(db, 'noc319_eval_type', 'warning', 'Teamless event', 'teamless', new Date().toISOString(), 'noc319-check-2', eventId);

      const logs = db.exec('SELECT COUNT(*) FROM alert_log WHERE rule_id = ?', [ruleId]);
      assert.strictEqual(logs[0].values[0][0], 0);
    });
  });

  describe('invitation accept requires authentication', () => {
    it('answers 401 for an anonymous caller', async () => {
      const team = await call(OWNER_CLERK, '/api/teams', {
        method: 'POST',
        body: JSON.stringify({ name: 'NOC-319 Anon Invite Team', slug: 'noc-319-anon-invite-team' }),
      });
      const invitation = await call(OWNER_CLERK, '/api/teams/' + team.body.id + '/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'noc319-anon@example.com', role: 'member' }),
      });
      assert.strictEqual(invitation.status, 200, JSON.stringify(invitation.body));

      const res = await fetchWithoutAuth('http://127.0.0.1:' + port + '/api/invitations/' + invitation.body.token + '/accept', {
        method: 'POST',
      });
      assert.strictEqual(res.status, 401);

      const memberships = db.exec('SELECT COUNT(*) FROM memberships WHERE team_id = ? AND user_id = ?', [team.body.id, 'noc319-anon@example.com']);
      assert.strictEqual(memberships[0].values[0][0], 0);
    });
  });

  describe('verification team cleanup', () => {
    it('removes only the teams with the verification prefix', async () => {
      const cleanupDb = await createDatabase();
      cleanupDb.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
        ['team-verify-1', 'Verify One', VERIFICATION_TEAM_PREFIX + 'one', 'owner-noc319', 'free']);
      cleanupDb.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
        ['team-verify-2', 'Verify Two', VERIFICATION_TEAM_PREFIX + 'two', 'owner-noc319', 'free']);
      cleanupDb.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
        ['team-real', 'Real Team', 'a-real-team', 'owner-noc319', 'free']);
      cleanupDb.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
        ['membership-verify-1', 'team-verify-1', 'owner-noc319', 'owner']);
      cleanupDb.run('INSERT INTO team_workspaces (id, team_id) VALUES (?, ?)', ['workspace-verify-1', 'team-verify-1']);
      cleanupDb.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, ?)',
        ['channel-verify-1', 'Verify channel', 'slack', '{}', 'team-verify-1']);

      const result = cleanupVerificationTeams(cleanupDb, VERIFICATION_TEAM_PREFIX);
      assert.strictEqual(result.teams.length, 2);

      const teams = cleanupDb.exec('SELECT slug FROM teams ORDER BY slug');
      const slugs = teams[0].values.map((row: any) => row[0]);
      assert.deepStrictEqual(slugs, ['a-real-team']);

      const memberships = cleanupDb.exec('SELECT COUNT(*) FROM memberships WHERE team_id = ?', ['team-verify-1']);
      assert.strictEqual(memberships[0].values[0][0], 0);
      const workspaces = cleanupDb.exec('SELECT COUNT(*) FROM team_workspaces WHERE team_id = ?', ['team-verify-1']);
      assert.strictEqual(workspaces[0].values[0][0], 0);
      const channels = cleanupDb.exec('SELECT COUNT(*) FROM alert_channels WHERE team_id = ?', ['team-verify-1']);
      assert.strictEqual(channels[0].values[0][0], 0);

      cleanupDb.close();
    });
  });
});