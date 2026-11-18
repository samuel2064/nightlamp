import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';

describe('Onboarding API', () => {
  let db: Database;
  let server: Server;
  let port: number;

  function asUser(clerkUserId: string, path: string, init: any = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set('authorization', 'Bearer ' + createTestToken({ sub: clerkUserId }));
    return fetchWithoutAuth('http://127.0.0.1:' + port + path, Object.assign({}, init, { headers }));
  }

  function internalUserId(clerkUserId: string): string {
    const result = db.exec('SELECT id FROM users WHERE clerk_user_id = ?', [clerkUserId]);
    assert.ok(result.length > 0 && result[0].values.length > 0, 'the identity must exist');
    return result[0].values[0][0] as string;
  }

  async function start(clerkUserId: string): Promise<any> {
    const res = await asUser(clerkUserId, '/api/onboarding/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return res.json() as Promise<any>;
  }

  async function advance(clerkUserId: string, sessionId: string, step: string, data: any = {}): Promise<any> {
    const res = await asUser(clerkUserId, '/api/onboarding/' + sessionId + '/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step, data }),
    });
    return res.json() as Promise<any>;
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner@example.com', 'Owner']);
    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  it('POST /api/onboarding/start creates a session for the authenticated user', async () => {
    const data = await start('onb-create-clerk');
    assert.strictEqual(data.success, true);
    assert.ok(data.sessionId);
    assert.strictEqual(data.currentStep, 'app-detection');
    assert.strictEqual(data.resumed, false);
    assert.strictEqual(data.userId, internalUserId('onb-create-clerk'));
  });

  it('POST /api/onboarding/start resumes existing incomplete session', async () => {
    const data1 = await start('onb-resume-clerk');
    assert.ok(data1.sessionId);

    const data2 = await start('onb-resume-clerk');
    assert.strictEqual(data2.resumed, true);
    assert.strictEqual(data2.sessionId, data1.sessionId);
  });

  it('POST /api/onboarding/start ignores a client supplied userId', async () => {
    const res = await asUser('onb-ignore-clerk', '/api/onboarding/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'someone-else' }),
    });
    const data = await res.json() as any;
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.userId, internalUserId('onb-ignore-clerk'));

    const row = db.exec('SELECT user_id FROM onboarding_sessions WHERE id = ?', [data.sessionId]);
    assert.strictEqual(row[0].values[0][0], internalUserId('onb-ignore-clerk'));
  });

  it('GET /api/onboarding/:id/status returns session progress', async () => {
    const { sessionId } = await start('onb-status-clerk');

    const res = await asUser('onb-status-clerk', '/api/onboarding/' + sessionId + '/status');
    const body = await res.json() as any;
    assert.strictEqual(body.session.id, sessionId);
    assert.strictEqual(body.session.currentStep, 'app-detection');
    assert.strictEqual(body.session.completed, false);
    assert.strictEqual(body.session.createdTeamId, null);
  });

  it('GET /api/onboarding/:id/status returns 404 for unknown session', async () => {
    const res = await asUser('onb-status-clerk', '/api/onboarding/nonexistent-id/status');
    assert.strictEqual(res.status, 404);
  });

  it('GET /api/onboarding/:id/status hides another identity session', async () => {
    const { sessionId } = await start('onb-private-clerk');

    const res = await asUser('onb-other-clerk', '/api/onboarding/' + sessionId + '/status');
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/step advances to next step', async () => {
    const { sessionId } = await start('onb-step-clerk');

    const stepData = await advance('onb-step-clerk', sessionId, 'monitor-selection', { monitors: ['sentry', 'uptimerobot'] });
    assert.strictEqual(stepData.success, true);
    assert.strictEqual(stepData.previousStep, 'app-detection');
    assert.strictEqual(stepData.currentStep, 'monitor-selection');

    const statusRes = await asUser('onb-step-clerk', '/api/onboarding/' + sessionId + '/status');
    const statusBody = await statusRes.json() as any;
    assert.strictEqual(statusBody.session.currentStep, 'monitor-selection');
    assert.deepStrictEqual(statusBody.session.stepData['monitor-selection'], { monitors: ['sentry', 'uptimerobot'] });
  });

  it('POST /api/onboarding/:id/step stores step-specific data', async () => {
    const { sessionId } = await start('onb-data-clerk');

    await advance('onb-data-clerk', sessionId, 'monitor-selection', { selected: ['monitor-a'] });
    await advance('onb-data-clerk', sessionId, 'alert-config', { email: 'test@example.com', slack: '#alerts' });

    const statusRes = await asUser('onb-data-clerk', '/api/onboarding/' + sessionId + '/status');
    const statusBody = await statusRes.json() as any;
    assert.strictEqual(statusBody.session.currentStep, 'alert-config');
    assert.deepStrictEqual(statusBody.session.stepData['monitor-selection'], { selected: ['monitor-a'] });
    assert.deepStrictEqual(statusBody.session.stepData['alert-config'], { email: 'test@example.com', slack: '#alerts' });
  });

  it('POST /api/onboarding/:id/step rejects out-of-order steps', async () => {
    const { sessionId } = await start('onb-order-clerk');

    const res = await asUser('onb-order-clerk', '/api/onboarding/' + sessionId + '/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'team-invite' }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error.includes('out of order'));
  });

  it('POST /api/onboarding/:id/step rejects invalid step names', async () => {
    const { sessionId } = await start('onb-invalid-clerk');

    const res = await asUser('onb-invalid-clerk', '/api/onboarding/' + sessionId + '/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'bogus-step' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/step requires step field', async () => {
    const { sessionId } = await start('onb-required-clerk');

    const res = await asUser('onb-required-clerk', '/api/onboarding/' + sessionId + '/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/step returns 404 for unknown session', async () => {
    const res = await asUser('onb-required-clerk', '/api/onboarding/nonexistent-id/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'monitor-selection' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/complete finalizes session and creates a team owned by the caller', async () => {
    const clerkUserId = 'onb-complete-clerk';
    const { sessionId } = await start(clerkUserId);

    await advance(clerkUserId, sessionId, 'monitor-selection', { monitors: ['sentry'] });
    await advance(clerkUserId, sessionId, 'alert-config', { email: 'user@test.com' });
    await advance(clerkUserId, sessionId, 'team-invite', { members: [] });

    const completeRes = await asUser(clerkUserId, '/api/onboarding/' + sessionId + '/complete', { method: 'POST' });
    const completeData = await completeRes.json() as any;
    assert.strictEqual(completeData.success, true);
    assert.ok(completeData.teamId);
    assert.ok(completeData.workspaceId);
    assert.ok(completeData.completedAt);

    const statusRes = await asUser(clerkUserId, '/api/onboarding/' + sessionId + '/status');
    const statusBody = await statusRes.json() as any;
    assert.strictEqual(statusBody.session.completed, true);
    assert.strictEqual(statusBody.session.createdTeamId, completeData.teamId);

    const teamRow = db.exec('SELECT owner_id FROM teams WHERE id = ?', [completeData.teamId]);
    assert.strictEqual(teamRow[0].values[0][0], internalUserId(clerkUserId));

    const membership = db.exec('SELECT user_id, role FROM memberships WHERE team_id = ?', [completeData.teamId]);
    assert.strictEqual(membership[0].values.length, 1);
    assert.strictEqual(membership[0].values[0][0], internalUserId(clerkUserId));
    assert.strictEqual(membership[0].values[0][1], 'owner');

    const teamRes = await asUser(clerkUserId, '/api/teams/' + completeData.teamId);
    const teamBody = await teamRes.json() as any;
    assert.ok(teamBody.team);
    assert.strictEqual(teamBody.team.id, completeData.teamId);
  });

  it('POST /api/onboarding/:id/complete rejects completion before team-invite step', async () => {
    const clerkUserId = 'onb-premature-clerk';
    const { sessionId } = await start(clerkUserId);

    const res = await asUser(clerkUserId, '/api/onboarding/' + sessionId + '/complete', { method: 'POST' });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/complete rejects duplicate completion', async () => {
    const clerkUserId = 'onb-dupe-clerk';
    const { sessionId } = await start(clerkUserId);

    await advance(clerkUserId, sessionId, 'monitor-selection');
    await advance(clerkUserId, sessionId, 'alert-config');
    await advance(clerkUserId, sessionId, 'team-invite');

    const res1 = await asUser(clerkUserId, '/api/onboarding/' + sessionId + '/complete', { method: 'POST' });
    assert.strictEqual(res1.status, 200);

    const res2 = await asUser(clerkUserId, '/api/onboarding/' + sessionId + '/complete', { method: 'POST' });
    assert.strictEqual(res2.status, 400);
  });

  it('POST /api/onboarding/:id/complete returns 404 for unknown session', async () => {
    const res = await asUser('onb-dupe-clerk', '/api/onboarding/nonexistent-id/complete', {
      method: 'POST',
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/complete refuses another identity session', async () => {
    const { sessionId } = await start('onb-steal-clerk');

    const res = await asUser('onb-thief-clerk', '/api/onboarding/' + sessionId + '/complete', { method: 'POST' });
    assert.strictEqual(res.status, 404);
  });
});
