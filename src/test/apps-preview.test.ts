import assert from 'assert';
import { createServer, Server } from 'http';
import { once } from 'events';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { EndpointCheckDeps } from '../engine/endpoint-check';
import { BlockedTargetError } from '../engine/outbound-safety';
import { createTestToken, fetchWithoutAuth } from './setup';

const testEndpointDeps: EndpointCheckDeps = {
  resolver: async () => ['93.184.216.34'],
  policy: {
    isBlockedAddress: () => false,
    isBlockedHostname: () => false,
  },
};

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

describe('ad-hoc app check preview', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let targetServer: Server;
  let targetPort: number;
  let teamId: string;
  const ownerToken = createTestToken({ sub: 'preview-owner', email: 'preview-owner-fixture-identity' });
  const personalToken = createTestToken({ sub: 'preview-personal', email: 'preview-personal-fixture-identity' });

  async function apiRequest(
    path: string,
    token: string | null,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  }

  async function preview(token: string | null, body: Record<string, unknown>): Promise<Response> {
    return apiRequest('/api/apps/test-check', token, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'preview-owner-user',
      'preview-owner',
      'preview-owner-fixture-identity',
      'Preview Owner',
    ]);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'preview-personal-user',
      'preview-personal',
      'preview-personal-fixture-identity',
      'Preview Personal',
    ]);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)', [
      teamId,
      'Preview Team',
      `preview-${teamId.slice(0, 8)}`,
      'preview-owner-user',
      'free',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      teamId,
      'preview-owner-user',
      'owner',
    ]);

    targetServer = createServer((req, res) => {
      if (req.url === '/unhealthy') {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('down');
        return;
      }
      if (req.url === '/missing-keyword') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('nightlamp-ok');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('nightlamp-ok');
    });
    targetPort = await listen(targetServer);

    server = startApiServer(db, {
      port: 0,
      appsApiDeps: { endpointDeps: testEndpointDeps, cooldownMs: 0 },
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    await close(server);
    await close(targetServer);
    if (db) db.close();
  });

  it('requires a session', async () => {
    const response = await preview(null, { checkTarget: `http://127.0.0.1:${targetPort}` });
    assert.strictEqual(response.status, 401);
  });

  it('refuses to run without an organization', async () => {
    const response = await preview(personalToken, { checkTarget: `http://127.0.0.1:${targetPort}` });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 403, JSON.stringify(body));
    assert.strictEqual(body.error, 'Applications require an organization');
  });

  it('runs a real check without creating an application', async () => {
    const response = await preview(ownerToken, {
      checkTarget: `http://127.0.0.1:${targetPort}/health`,
      checkType: 'http',
      checkTimeoutSec: 2,
    });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.result.status, 'pass');
    assert.strictEqual(body.result.statusCode, 200);
    assert.strictEqual(body.result.errorType, null);
    assert.strictEqual(body.result.errorDetail, null);
    assert.ok(typeof body.result.latencyMs === 'number');
    assert.ok(typeof body.result.checkedAt === 'string');

    const rows = db.exec('SELECT COUNT(*) FROM monitored_apps');
    assert.strictEqual(rows[0].values[0][0], 0, 'preview must not persist an application');
    const snapshots = db.exec('SELECT COUNT(*) FROM health_snapshots');
    assert.strictEqual(snapshots[0].values[0][0], 0, 'preview must not persist a snapshot');
  });

  it('reports a failed check as a result instead of an error', async () => {
    const response = await preview(ownerToken, {
      checkTarget: `http://127.0.0.1:${targetPort}/unhealthy`,
      checkType: 'http',
      checkTimeoutSec: 2,
    });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.result.status, 'fail');
    assert.strictEqual(body.result.statusCode, 500);
    assert.strictEqual(body.result.errorType, 'http_5xx');
  });

  it('reports an unreachable target as a failed result', async () => {
    const response = await preview(ownerToken, {
      checkTarget: 'http://127.0.0.1:1',
      checkType: 'http',
      checkTimeoutSec: 2,
    });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.result.status, 'fail');
    assert.ok(body.result.errorType, 'expected a classified failure type');
  });

  it('rejects an invalid check type and a missing target', async () => {
    const badType = await preview(ownerToken, {
      checkTarget: `http://127.0.0.1:${targetPort}`,
      checkType: 'ftp',
    });
    const badTypeBody = await badType.json() as any;
    assert.strictEqual(badType.status, 400, JSON.stringify(badTypeBody));
    assert.ok(badTypeBody.fields.checkType, 'expected a checkType field error');

    const missingTarget = await preview(ownerToken, {});
    const missingTargetBody = await missingTarget.json() as any;
    assert.strictEqual(missingTarget.status, 400, JSON.stringify(missingTargetBody));
    assert.ok(missingTargetBody.fields.checkTarget, 'expected a checkTarget field error');
  });

  it('requires a keyword for keyword checks', async () => {
    const response = await preview(ownerToken, {
      checkTarget: `http://127.0.0.1:${targetPort}/missing-keyword`,
      checkType: 'keyword',
      checkTimeoutSec: 2,
    });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 400, JSON.stringify(body));
    assert.ok(body.fields.keyword, 'expected a keyword field error');
  });

  it('reports a missing keyword in the response body', async () => {
    const response = await preview(ownerToken, {
      checkTarget: `http://127.0.0.1:${targetPort}/missing-keyword`,
      checkType: 'keyword',
      keyword: 'not-present',
      checkTimeoutSec: 2,
    });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.result.status, 'fail');
    assert.strictEqual(body.result.errorType, 'keyword_not_found');
  });

  it('refuses to run against a blocked target', async () => {
    const blockedServer = startApiServer(db, {
      port: 0,
      appsApiDeps: {
        endpointDeps: testEndpointDeps,
        cooldownMs: 0,
        assertTargetAllowed: async () => {
          throw new BlockedTargetError('target resolves to a blocked address');
        },
      },
    });
    const blockedPort = (blockedServer.address() as { port: number }).port;
    try {
      const response = await fetchWithoutAuth(`http://127.0.0.1:${blockedPort}/api/apps/test-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ checkTarget: `http://127.0.0.1:${targetPort}` }),
      });
      const body = await response.json() as any;
      assert.strictEqual(response.status, 400, JSON.stringify(body));
      assert.ok(body.fields.checkTarget, 'expected a checkTarget field error');
    } finally {
      await close(blockedServer);
    }
  });

  it('cooldown limits repeated previews for the same target', async () => {
    const cooldownServer = startApiServer(db, {
      port: 0,
      appsApiDeps: { endpointDeps: testEndpointDeps, cooldownMs: 5000 },
    });
    const cooldownPort = (cooldownServer.address() as { port: number }).port;
    try {
      const send = () => fetchWithoutAuth(`http://127.0.0.1:${cooldownPort}/api/apps/test-check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({
          checkTarget: `http://127.0.0.1:${targetPort}/cooldown`,
          checkType: 'http',
          checkTimeoutSec: 2,
        }),
      });

      const first = await send();
      assert.strictEqual(first.status, 200, await first.text());

      const second = await send();
      const secondBody = await second.json() as any;
      assert.strictEqual(second.status, 429, JSON.stringify(secondBody));
      assert.ok(secondBody.retryAfterSec >= 1, 'expected a retryAfterSec hint');
      assert.ok(Number(second.headers.get('retry-after')) >= 1, 'expected a Retry-After header');
    } finally {
      await close(cooldownServer);
    }
  });
});
