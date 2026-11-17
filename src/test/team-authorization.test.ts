import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';

const MEMBER_CLERK_USER_ID = 'member-clerk-user';
const MEMBER_USER_ID = 'member-user';
const ADMIN_CLERK_USER_ID = 'admin-clerk-user';
const ADMIN_USER_ID = 'admin-user';
const OUTSIDER_CLERK_USER_ID = 'outsider-clerk-user';
const OUTSIDER_USER_ID = 'outsider-user';

describe('Team management authorization', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner@example.com', 'Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [MEMBER_USER_ID, MEMBER_CLERK_USER_ID, 'member@example.com', 'Member']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [ADMIN_USER_ID, ADMIN_CLERK_USER_ID, 'admin@example.com', 'Admin']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [OUTSIDER_USER_ID, OUTSIDER_CLERK_USER_ID, 'outsider@example.com', 'Outsider']);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'Authorization Team', 'authorization-team', TEST_LOCAL_USER_ID, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, TEST_LOCAL_USER_ID, 'owner']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, MEMBER_USER_ID, 'member']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, ADMIN_USER_ID, 'admin']);

    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  beforeEach(() => {
    db.run('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?', ['member', teamId, MEMBER_USER_ID]);
    db.run('UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?', ['admin', teamId, ADMIN_USER_ID]);
  });

  function asUser(clerkUserId: string, path: string, init: any = {}, team?: string): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set('authorization', `Bearer ${createTestToken(team ? { sub: clerkUserId, org_id: team } : { sub: clerkUserId })}`);
    return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  }

  function roleOf(userId: string): string | null {
    const result = db.exec('SELECT role FROM memberships WHERE team_id = ? AND user_id = ?', [teamId, userId]);
    return result.length > 0 && result[0].values.length > 0 ? result[0].values[0][0] : null;
  }

  it('refuses a member who promotes themselves to owner', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, `/api/teams/${teamId}/members/${MEMBER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(roleOf(MEMBER_USER_ID), 'member');
  });

  it('keeps the admin endpoints closed to a member after the promotion attempt', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, '/api/alerting/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Escalated channel', type: 'slack', target: 'https://hooks.example.com/x' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
  });

  it('refuses a member who adds a member with an admin role', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, `/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'planted-user', role: 'admin' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(roleOf('planted-user'), null);
  });

  it('refuses a member who removes another member', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, `/api/teams/${teamId}/members/${ADMIN_USER_ID}`, {
      method: 'DELETE',
    }, teamId);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(roleOf(ADMIN_USER_ID), 'admin');
  });

  it('refuses a member who deletes the team', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, `/api/teams/${teamId}`, {
      method: 'DELETE',
    }, teamId);

    assert.strictEqual(res.status, 403);
    const teams = db.exec('SELECT id FROM teams WHERE id = ?', [teamId]);
    assert.strictEqual(teams[0].values.length, 1);
  });

  it('refuses a member who rewrites the team', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, `/api/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Taken Over' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
    const team = db.exec('SELECT name FROM teams WHERE id = ?', [teamId]);
    assert.strictEqual(team[0].values[0][0], 'Authorization Team');
  });

  it('refuses a member who creates an owner invitation', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, `/api/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: MEMBER_USER_ID, role: 'owner' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
    const invitations = db.exec('SELECT id FROM invitations WHERE team_id = ?', [teamId]);
    assert.strictEqual(invitations.length > 0 ? invitations[0].values.length : 0, 0);
  });

  it('refuses a member who creates a team owned by somebody else', async () => {
    const res = await asUser(MEMBER_CLERK_USER_ID, '/api/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Stolen Team', slug: 'stolen-team', ownerId: TEST_LOCAL_USER_ID }),
    }, teamId);

    assert.strictEqual(res.status, 403);
    const stolen = db.exec('SELECT id FROM teams WHERE slug = ?', ['stolen-team']);
    assert.strictEqual(stolen.length > 0 ? stolen[0].values.length : 0, 0);
  });

  it('refuses an unauthenticated role change', async () => {
    const res = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/teams/${teamId}/members/${MEMBER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    });

    assert.strictEqual(res.status, 401);
    assert.strictEqual(roleOf(MEMBER_USER_ID), 'member');
  });

  it('refuses a signed-in user with no membership', async () => {
    const res = await asUser(OUTSIDER_CLERK_USER_ID, `/api/teams/${teamId}/members/${MEMBER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    });

    assert.strictEqual(res.status, 403);
    assert.strictEqual(roleOf(MEMBER_USER_ID), 'member');
  });

  it('answers 404 for an unknown team', async () => {
    const res = await asUser(TEST_CLERK_USER_ID, '/api/teams/no-such-team/members/someone', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    }, teamId);

    assert.strictEqual(res.status, 404);
  });

  it('answers 404 for a role change on somebody who is not a member', async () => {
    const res = await asUser(TEST_CLERK_USER_ID, `/api/teams/${teamId}/members/not-a-member`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    }, teamId);

    assert.strictEqual(res.status, 404);
  });

  it('lets an admin change a member role', async () => {
    const res = await asUser(ADMIN_CLERK_USER_ID, `/api/teams/${teamId}/members/${MEMBER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    }, teamId);

    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json() as any).success, true);
    assert.strictEqual(roleOf(MEMBER_USER_ID), 'admin');
  });

  it('refuses an admin who grants the owner role', async () => {
    const res = await asUser(ADMIN_CLERK_USER_ID, `/api/teams/${teamId}/members/${MEMBER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
    assert.strictEqual(roleOf(MEMBER_USER_ID), 'member');
  });

  it('refuses an admin who invites a new owner', async () => {
    const res = await asUser(ADMIN_CLERK_USER_ID, `/api/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new-owner@example.com', role: 'owner' }),
    }, teamId);

    assert.strictEqual(res.status, 403);
  });

  it('lets the owner grant the owner role', async () => {
    const res = await asUser(TEST_CLERK_USER_ID, `/api/teams/${teamId}/members/${MEMBER_USER_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'owner' }),
    }, teamId);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(roleOf(MEMBER_USER_ID), 'owner');
  });

  it('lets an admin invite a member', async () => {
    const res = await asUser(ADMIN_CLERK_USER_ID, `/api/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invitee@example.com', role: 'member' }),
    }, teamId);

    assert.strictEqual(res.status, 200);
    const invitations = db.exec('SELECT role FROM invitations WHERE team_id = ?', [teamId]);
    assert.strictEqual(invitations[0].values.length, 1);
    assert.strictEqual(invitations[0].values[0][0], 'member');
  });

  it('refuses an invitation with an unknown role', async () => {
    const res = await asUser(TEST_CLERK_USER_ID, `/api/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bogus@example.com', role: 'superuser' }),
    }, teamId);

    assert.strictEqual(res.status, 400);
  });
});
