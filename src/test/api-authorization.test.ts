import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { appRouter, createTRPCContext, createTRPCContextFromNodeRequest } from '../api/trpc';
import { ApiAuthError, authenticateRequest, verifyAccessToken } from '../api/auth';
import { createPlaybookEngine } from '../playbook/engine';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { IncomingMessage } from 'http';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_JWT_SECRET, TEST_LOCAL_USER_ID } from './setup';

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

    otherTeamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [otherTeamId, 'Other Team', 'other-team', 'someone-else', 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), otherTeamId, 'someone-else', 'owner']);

    server = startApiServer(db, { port: 0 });
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
});
