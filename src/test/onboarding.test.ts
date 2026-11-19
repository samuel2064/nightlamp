import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';

// Onboarding sessions bind to the authenticated principal, so every test runs
// as its own identity and the body userId must equal the caller (NOC-319).
const IDENTITIES = [
  'user-start', 'user-resume', 'user-status', 'user-step', 'user-data', 'user-order',
  'user-invalid', 'user-required', 'user-complete', 'user-premature', 'user-dupe',
];

describe('Onboarding API', () => {
  let db: Database;
  let server: Server;
  let port: number;

  function callAs(userId: string, path: string, init: any = {}): Promise<Response> {
    const headers = new Headers(init.headers || {});
    headers.set('authorization', 'Bearer ' + createTestToken({ sub: `${userId}-clerk`, email: `${userId}@example.com` }));
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    return fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, Object.assign({}, init, { headers }));
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner@example.com', 'Owner']);
    for (const userId of IDENTITIES) {
      db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
        [userId, `${userId}-clerk`, `${userId}@example.com`, userId]);
    }
    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  it('POST /api/onboarding/start creates a session', async () => {
    const res = await callAs('user-start', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-start' }),
    });
    const data = await res.json() as any;
    assert.strictEqual(data.success, true);
    assert.ok(data.sessionId);
    assert.strictEqual(data.currentStep, 'app-detection');
    assert.strictEqual(data.resumed, false);
  });

  it('POST /api/onboarding/start resumes existing incomplete session', async () => {
    const res1 = await callAs('user-resume', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-resume' }),
    });
    const data1 = await res1.json() as any;
    assert.ok(data1.sessionId);

    const res2 = await callAs('user-resume', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-resume' }),
    });
    const data2 = await res2.json() as any;
    assert.strictEqual(data2.resumed, true);
    assert.strictEqual(data2.sessionId, data1.sessionId);
  });

  it('POST /api/onboarding/start requires userId', async () => {
    const res = await callAs('user-start', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/start refuses a body identity that is not the caller', async () => {
    const res = await callAs('user-start', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'someone-else' }),
    });
    assert.strictEqual(res.status, 403);
    const rows = db.exec("SELECT COUNT(*) FROM onboarding_sessions WHERE user_id = 'someone-else'");
    assert.strictEqual(rows[0].values[0][0], 0);
  });

  it('GET /api/onboarding/:id/status returns session progress', async () => {
    const startRes = await callAs('user-status', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-status' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await callAs('user-status', `/api/onboarding/${sessionId}/status`);
    const data = await res.json() as any;
    assert.strictEqual(data.session.id, sessionId);
    assert.strictEqual(data.session.currentStep, 'app-detection');
    assert.strictEqual(data.session.completed, false);
    assert.strictEqual(data.session.createdTeamId, null);
  });

  it('GET /api/onboarding/:id/status returns 404 for unknown session', async () => {
    const res = await callAs('user-status', '/api/onboarding/nonexistent-id/status');
    assert.strictEqual(res.status, 404);
  });

  it('GET /api/onboarding/:id/status hides another user session', async () => {
    const startRes = await callAs('user-status', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-status' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await callAs('user-data', `/api/onboarding/${sessionId}/status`);
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/step advances to next step', async () => {
    const startRes = await callAs('user-step', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-step' }),
    });
    const { sessionId } = await startRes.json() as any;

    const stepRes = await callAs('user-step', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'monitor-selection', data: { monitors: ['sentry', 'uptimerobot'] } }),
    });
    const stepData = await stepRes.json() as any;
    assert.strictEqual(stepData.success, true);
    assert.strictEqual(stepData.previousStep, 'app-detection');
    assert.strictEqual(stepData.currentStep, 'monitor-selection');

    const statusRes = await callAs('user-step', `/api/onboarding/${sessionId}/status`);
    const statusData = await statusRes.json() as any;
    assert.strictEqual(statusData.session.currentStep, 'monitor-selection');
    assert.deepStrictEqual(statusData.session.stepData['monitor-selection'], { monitors: ['sentry', 'uptimerobot'] });
  });

  it('POST /api/onboarding/:id/step stores step-specific data', async () => {
    const startRes = await callAs('user-data', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-data' }),
    });
    const { sessionId } = await startRes.json() as any;

    await callAs('user-data', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'monitor-selection', data: { selected: ['monitor-a'] } }),
    });

    await callAs('user-data', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'alert-config', data: { email: 'test@example.com', slack: '#alerts' } }),
    });

    const statusRes = await callAs('user-data', `/api/onboarding/${sessionId}/status`);
    const statusData = await statusRes.json() as any;
    assert.strictEqual(statusData.session.currentStep, 'alert-config');
    assert.deepStrictEqual(statusData.session.stepData['monitor-selection'], { selected: ['monitor-a'] });
    assert.deepStrictEqual(statusData.session.stepData['alert-config'], { email: 'test@example.com', slack: '#alerts' });
  });

  it('POST /api/onboarding/:id/step rejects out-of-order steps', async () => {
    const startRes = await callAs('user-order', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-order' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await callAs('user-order', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'team-invite' }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error.includes('out of order'));
  });

  it('POST /api/onboarding/:id/step rejects invalid step names', async () => {
    const startRes = await callAs('user-invalid', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-invalid' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await callAs('user-invalid', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'bogus-step' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/step requires step field', async () => {
    const startRes = await callAs('user-required', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-required' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await callAs('user-required', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ data: {} }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/step returns 404 for unknown session', async () => {
    const res = await callAs('user-step', '/api/onboarding/nonexistent-id/step', {
      method: 'POST',
      body: JSON.stringify({ step: 'monitor-selection' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/complete finalizes session and creates team', async () => {
    const startRes = await callAs('user-complete', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-complete' }),
    });
    const { sessionId } = await startRes.json() as any;

    await callAs('user-complete', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'monitor-selection', data: { monitors: ['sentry'] } }),
    });

    await callAs('user-complete', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'alert-config', data: { email: 'user@test.com' } }),
    });

    await callAs('user-complete', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'team-invite', data: { members: [] } }),
    });

    const completeRes = await callAs('user-complete', `/api/onboarding/${sessionId}/complete`, {
      method: 'POST',
    });
    const completeData = await completeRes.json() as any;
    assert.strictEqual(completeData.success, true);
    assert.ok(completeData.teamId);
    assert.ok(completeData.workspaceId);
    assert.ok(completeData.completedAt);

    const statusRes = await callAs('user-complete', `/api/onboarding/${sessionId}/status`);
    const statusData = await statusRes.json() as any;
    assert.strictEqual(statusData.session.completed, true);
    assert.strictEqual(statusData.session.createdTeamId, completeData.teamId);

    // The completed session creates a team owned by the authenticated user.
    const team = db.exec('SELECT owner_id FROM teams WHERE id = ?', [completeData.teamId]);
    assert.strictEqual(team[0].values[0][0], 'user-complete');

    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [('m-' + completeData.teamId) as string, completeData.teamId, TEST_LOCAL_USER_ID, 'owner']);

    const teamRes = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/teams/${completeData.teamId}`, {
      headers: { Authorization: `Bearer ${createTestToken()}` },
    });
    const teamData = await teamRes.json() as any;
    assert.ok(teamData.team);
    assert.strictEqual(teamData.team.id, completeData.teamId);
  });

  it('POST /api/onboarding/:id/complete rejects completion before team-invite step', async () => {
    const startRes = await callAs('user-premature', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-premature' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await callAs('user-premature', `/api/onboarding/${sessionId}/complete`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/complete rejects duplicate completion', async () => {
    const startRes = await callAs('user-dupe', '/api/onboarding/start', {
      method: 'POST',
      body: JSON.stringify({ userId: 'user-dupe' }),
    });
    const { sessionId } = await startRes.json() as any;

    await callAs('user-dupe', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'monitor-selection' }),
    });

    await callAs('user-dupe', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'alert-config' }),
    });

    await callAs('user-dupe', `/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      body: JSON.stringify({ step: 'team-invite' }),
    });

    const res1 = await callAs('user-dupe', `/api/onboarding/${sessionId}/complete`, { method: 'POST' });
    assert.strictEqual(res1.status, 200);

    const res2 = await callAs('user-dupe', `/api/onboarding/${sessionId}/complete`, { method: 'POST' });
    assert.strictEqual(res2.status, 400);
  });

  it('POST /api/onboarding/:id/complete returns 404 for unknown session', async () => {
    const res = await callAs('user-dupe', '/api/onboarding/nonexistent-id/complete', {
      method: 'POST',
    });
    assert.strictEqual(res.status, 404);
  });
});