import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';

describe('Teams API', () => {
  let db: Database;
  let server: Server;
  let port: number;

  before(async () => {
    db = await createDatabase();
    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  it('POST /api/teams creates a team', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test Team', slug: 'test-team', ownerId: 'user-1', plan: 'basic' }),
    });
    const data = await res.json() as any;
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.name, 'Test Team');
    assert.strictEqual(data.slug, 'test-team');
    assert.strictEqual(data.plan, 'basic');
  });

  it('POST /api/teams creates a workspace and owner membership', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Team 2', slug: 'team-2', ownerId: 'user-2' }),
    });
    const data = await res.json() as any;
    assert.strictEqual(data.success, true);

    const wsRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${data.id}/workspace`)).json() as any;
    assert.ok(wsRes.workspace);
    assert.strictEqual(wsRes.workspace.teamId, data.id);
    assert.deepStrictEqual(wsRes.workspace.monitors, []);
    assert.deepStrictEqual(wsRes.workspace.playbooks, []);
    assert.deepStrictEqual(wsRes.workspace.alerts, []);

    const membersRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${data.id}/members`)).json() as any;
    assert.strictEqual(membersRes.count, 1);
    assert.strictEqual(membersRes.members[0].userId, 'user-2');
    assert.strictEqual(membersRes.members[0].role, 'owner');
  });

  it('POST /api/teams rejects duplicate slug', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Duplicate', slug: 'test-team', ownerId: 'user-1' }),
    });
    assert.strictEqual(res.status, 409);
  });

  it('POST /api/teams requires required fields', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Incomplete' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('GET /api/teams lists teams', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/teams`)).json() as any;
    assert.ok(res.count >= 2);
    assert.ok(res.teams.some((t: any) => t.slug === 'test-team'));
  });

  it('GET /api/teams/:id returns a team', async () => {
    const listRes = await (await fetch(`http://127.0.0.1:${port}/api/teams`)).json() as any;
    const teamId = listRes.teams[0].id;

    const res = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}`)).json() as any;
    assert.ok(res.team);
    assert.strictEqual(res.team.id, teamId);
  });

  it('GET /api/teams/:id returns 404 for unknown team', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/teams/nonexistent-id`);
    assert.strictEqual(res.status, 404);
  });

  it('PATCH /api/teams/:id updates team', async () => {
    const listRes = await (await fetch(`http://127.0.0.1:${port}/api/teams`)).json() as any;
    const teamId = listRes.teams[0].id;

    const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated Team' }),
    });
    assert.strictEqual((await res.json()).success, true);

    const getRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}`)).json() as any;
    assert.strictEqual(getRes.team.name, 'Updated Team');
  });

  it('DELETE /api/teams/:id deletes team and related data', async () => {
    const createRes = await fetch(`http://127.0.0.1:${port}/api/teams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'To Delete', slug: 'to-delete', ownerId: 'user-del' }),
    });
    const { id } = await createRes.json() as any;

    const delRes = await fetch(`http://127.0.0.1:${port}/api/teams/${id}`, { method: 'DELETE' });
    assert.strictEqual((await delRes.json()).success, true);

    const getRes = await fetch(`http://127.0.0.1:${port}/api/teams/${id}`);
    assert.strictEqual(getRes.status, 404);
  });

  describe('Members', () => {
    let teamId: string;

    before(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Members Team', slug: 'members-team', ownerId: 'owner-1' }),
      });
      teamId = (await res.json()).id;
    });

    it('POST /api/teams/:id/members adds a member', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'member-1', role: 'admin' }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.role, 'admin');
    });

    it('POST /api/teams/:id/members defaults to member role', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'member-2' }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.role, 'member');
    });

    it('POST /api/teams/:id/members rejects duplicate member', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'member-1' }),
      });
      assert.strictEqual(res.status, 409);
    });

    it('POST /api/teams/:id/members requires userId', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('GET /api/teams/:id/members lists members', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`)).json() as any;
      assert.strictEqual(res.count, 3);
      assert.ok(res.members.some((m: any) => m.userId === 'member-1'));
      assert.ok(res.members.some((m: any) => m.userId === 'member-2'));
    });

    it('PATCH /api/teams/:id/members/:userId updates role', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members/member-1`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      });
      assert.strictEqual((await res.json()).success, true);

      const membersRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`)).json() as any;
      const member = membersRes.members.find((m: any) => m.userId === 'member-1');
      assert.strictEqual(member.role, 'member');
    });

    it('DELETE /api/teams/:id/members/:userId removes member', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members/member-2`, {
        method: 'DELETE',
      });
      assert.strictEqual((await res.json()).success, true);

      const membersRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`)).json() as any;
      assert.strictEqual(membersRes.count, 2);
    });
  });

  describe('Workspace', () => {
    let teamId: string;

    before(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Workspace Team', slug: 'workspace-team', ownerId: 'ws-owner' }),
      });
      teamId = (await res.json()).id;
    });

    it('GET /api/teams/:id/workspace returns workspace', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/workspace`)).json() as any;
      assert.ok(res.workspace);
      assert.strictEqual(res.workspace.teamId, teamId);
    });

    it('PATCH /api/teams/:id/workspace updates workspace', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/workspace`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitors: ['check-1', 'check-2'],
          settings: { theme: 'dark' },
        }),
      });
      assert.strictEqual((await res.json()).success, true);

      const wsRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/workspace`)).json() as any;
      assert.deepStrictEqual(wsRes.workspace.monitors, ['check-1', 'check-2']);
      assert.deepStrictEqual(wsRes.workspace.settings, { theme: 'dark' });
    });
  });

  describe('Invitations', () => {
    let teamId: string;

    before(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Invite Team', slug: 'invite-team', ownerId: 'inv-owner' }),
      });
      teamId = (await res.json()).id;
    });

    it('POST /api/teams/:id/invitations creates invitation', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', role: 'member' }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.email, 'test@example.com');
      assert.ok(data.token);
      assert.ok(new Date(data.expiresAt) > new Date());
    });

    it('GET /api/invitations/:token looks up valid invitation', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'lookup@example.com', role: 'admin' }),
      });
      const { token } = await createRes.json() as any;

      const res = await (await fetch(`http://127.0.0.1:${port}/api/invitations/${token}`)).json() as any;
      assert.strictEqual(res.invitation.email, 'lookup@example.com');
      assert.strictEqual(res.invitation.role, 'admin');
    });

    it('GET /api/invitations/:token returns 404 for bad token', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/invitations/bad-token`);
      assert.strictEqual(res.status, 404);
    });

    it('POST /api/invitations/:token/accept creates membership', async () => {
      const createRes = await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'accept-user', role: 'admin' }),
      });
      const { token } = await createRes.json() as any;

      const res = await fetch(`http://127.0.0.1:${port}/api/invitations/${token}/accept`, {
        method: 'POST',
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.role, 'admin');

      const membersRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${teamId}/members`)).json() as any;
      assert.ok(membersRes.members.some((m: any) => m.userId === 'accept-user'));
    });
  });
});
