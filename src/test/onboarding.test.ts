import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';

describe('Onboarding API', () => {
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

  it('POST /api/onboarding/start creates a session', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-1' }),
    });
    const data = await res.json() as any;
    assert.strictEqual(data.success, true);
    assert.ok(data.sessionId);
    assert.strictEqual(data.currentStep, 'app-detection');
    assert.strictEqual(data.resumed, false);
  });

  it('POST /api/onboarding/start resumes existing incomplete session', async () => {
    const res1 = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-resume' }),
    });
    const data1 = await res1.json() as any;
    assert.ok(data1.sessionId);

    const res2 = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-resume' }),
    });
    const data2 = await res2.json() as any;
    assert.strictEqual(data2.resumed, true);
    assert.strictEqual(data2.sessionId, data1.sessionId);
  });

  it('POST /api/onboarding/start requires userId', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it('GET /api/onboarding/:id/status returns session progress', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-status' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await (await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/status`)).json() as any;
    assert.strictEqual(res.session.id, sessionId);
    assert.strictEqual(res.session.currentStep, 'app-detection');
    assert.strictEqual(res.session.completed, false);
    assert.strictEqual(res.session.createdTeamId, null);
  });

  it('GET /api/onboarding/:id/status returns 404 for unknown session', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/nonexistent-id/status`);
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/step advances to next step', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-step' }),
    });
    const { sessionId } = await startRes.json() as any;

    const stepRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'monitor-selection', data: { monitors: ['sentry', 'uptimerobot'] } }),
    });
    const stepData = await stepRes.json() as any;
    assert.strictEqual(stepData.success, true);
    assert.strictEqual(stepData.previousStep, 'app-detection');
    assert.strictEqual(stepData.currentStep, 'monitor-selection');

    const statusRes = await (await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/status`)).json() as any;
    assert.strictEqual(statusRes.session.currentStep, 'monitor-selection');
    assert.deepStrictEqual(statusRes.session.stepData['monitor-selection'], { monitors: ['sentry', 'uptimerobot'] });
  });

  it('POST /api/onboarding/:id/step stores step-specific data', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-data' }),
    });
    const { sessionId } = await startRes.json() as any;

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'monitor-selection', data: { selected: ['monitor-a'] } }),
    });

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'alert-config', data: { email: 'test@example.com', slack: '#alerts' } }),
    });

    const statusRes = await (await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/status`)).json() as any;
    assert.strictEqual(statusRes.session.currentStep, 'alert-config');
    assert.deepStrictEqual(statusRes.session.stepData['monitor-selection'], { selected: ['monitor-a'] });
    assert.deepStrictEqual(statusRes.session.stepData['alert-config'], { email: 'test@example.com', slack: '#alerts' });
  });

  it('POST /api/onboarding/:id/step rejects out-of-order steps', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-order' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'team-invite' }),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error.includes('out of order'));
  });

  it('POST /api/onboarding/:id/step rejects invalid step names', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-invalid' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'bogus-step' }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/step requires step field', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-required' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/step returns 404 for unknown session', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/nonexistent-id/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'monitor-selection' }),
    });
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/onboarding/:id/complete finalizes session and creates team', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-complete' }),
    });
    const { sessionId } = await startRes.json() as any;

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'monitor-selection', data: { monitors: ['sentry'] } }),
    });

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'alert-config', data: { email: 'user@test.com' } }),
    });

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'team-invite', data: { members: [] } }),
    });

    const completeRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/complete`, {
      method: 'POST',
    });
    const completeData = await completeRes.json() as any;
    assert.strictEqual(completeData.success, true);
    assert.ok(completeData.teamId);
    assert.ok(completeData.workspaceId);
    assert.ok(completeData.completedAt);

    const statusRes = await (await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/status`)).json() as any;
    assert.strictEqual(statusRes.session.completed, true);
    assert.strictEqual(statusRes.session.createdTeamId, completeData.teamId);

    const teamRes = await (await fetch(`http://127.0.0.1:${port}/api/teams/${completeData.teamId}`)).json() as any;
    assert.ok(teamRes.team);
    assert.strictEqual(teamRes.team.id, completeData.teamId);
  });

  it('POST /api/onboarding/:id/complete rejects completion before team-invite step', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-premature' }),
    });
    const { sessionId } = await startRes.json() as any;

    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/complete`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/onboarding/:id/complete rejects duplicate completion', async () => {
    const startRes = await fetch(`http://127.0.0.1:${port}/api/onboarding/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'user-dupe' }),
    });
    const { sessionId } = await startRes.json() as any;

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'monitor-selection' }),
    });

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'alert-config' }),
    });

    await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 'team-invite' }),
    });

    const res1 = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/complete`, { method: 'POST' });
    assert.strictEqual(res1.status, 200);

    const res2 = await fetch(`http://127.0.0.1:${port}/api/onboarding/${sessionId}/complete`, { method: 'POST' });
    assert.strictEqual(res2.status, 400);
  });

  it('POST /api/onboarding/:id/complete returns 404 for unknown session', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/onboarding/nonexistent-id/complete`, {
      method: 'POST',
    });
    assert.strictEqual(res.status, 404);
  });
});
