import assert from 'assert';
import { createServer, Server } from 'http';
import { createServer as createNetServer, Server as NetServer } from 'net';
import { once } from 'events';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { EndpointCheckDeps } from '../engine/endpoint-check';
import { createTestToken, fetchWithoutAuth } from './setup';

const testEndpointDeps: EndpointCheckDeps = {
  resolver: async () => ['93.184.216.34'],
  policy: {
    isBlockedAddress: () => false,
    isBlockedHostname: () => false,
  },
};

async function listen(server: Server | NetServer): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as { port: number }).port;
}

async function close(server: Server | NetServer): Promise<void> {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

describe('tenant-scoped app registry', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let targetServer: Server;
  let targetPort: number;
  let tcpServer: NetServer;
  let tcpPort: number;
  let targetRequests: number;
  let teamId: string;
  let otherTeamId: string;
  let ownChannelId: string;
  let foreignChannelId: string;
  let personalChannelId: string;
  let ownAppId: string;
  let foreignAppId: string;
  const ownerToken = createTestToken({ sub: 'owner-clerk', email: 'owner@example.com' });
  const otherToken = createTestToken({ sub: 'other-clerk', email: 'other@example.com' });
  const personalToken = createTestToken({ sub: 'personal-clerk', email: 'personal@example.com' });

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

  async function createApp(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<any> {
    const response = await apiRequest('/api/apps', token, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Customer App',
        url: `http://127.0.0.1:${targetPort}`,
        platform: 'custom',
        checkType: 'http',
        checkTarget: `http://127.0.0.1:${targetPort}`,
        checkIntervalSec: 30,
        checkTimeoutSec: 2,
        enabled: true,
        alertChannelId: ownChannelId,
        ...overrides,
      }),
    });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 201, JSON.stringify(body));
    return body.app;
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'owner-user',
      'owner-clerk',
      'owner@example.com',
      'Owner',
    ]);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'other-user',
      'other-clerk',
      'other@example.com',
      'Other',
    ]);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'personal-user',
      'personal-clerk',
      'personal@example.com',
      'Personal',
    ]);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)', [
      teamId,
      'Primary Team',
      `primary-${teamId.slice(0, 8)}`,
      'owner-user',
      'free',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      teamId,
      'owner-user',
      'owner',
    ]);

    otherTeamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)', [
      otherTeamId,
      'Other Team',
      `other-${otherTeamId.slice(0, 8)}`,
      'other-user',
      'free',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      otherTeamId,
      'other-user',
      'owner',
    ]);

    targetRequests = 0;
    targetServer = createServer((req, res) => {
      targetRequests += 1;
      if (req.url === '/missing') {
        res.writeHead(404);
        res.end('missing');
        return;
      }
      if (req.url === '/failure') {
        res.writeHead(500);
        res.end('failure');
        return;
      }
      if (req.url === '/slow') {
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('nightlamp-ok');
    });
    targetPort = await listen(targetServer);

    tcpServer = createNetServer((socket) => socket.end());
    tcpPort = await listen(tcpServer);

    server = startApiServer(db, {
      port: 0,
      appsApiDeps: { endpointDeps: testEndpointDeps, cooldownMs: 0 },
    });
    port = (server.address() as { port: number }).port;

    const channelResponse = await apiRequest('/api/alerting/channels', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Own alerts',
        type: 'slack',
        config: { webhookUrl: 'https://example.invalid/hook' },
      }),
    });
    const channelBody = await channelResponse.json() as any;
    assert.strictEqual(channelResponse.status, 200, JSON.stringify(channelBody));
    ownChannelId = channelBody.id;

    const foreignChannelResponse = await apiRequest('/api/alerting/channels', otherToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Foreign alerts',
        type: 'slack',
        config: { webhookUrl: 'https://example.invalid/foreign-hook' },
      }),
    });
    const foreignChannelBody = await foreignChannelResponse.json() as any;
    assert.strictEqual(foreignChannelResponse.status, 200, JSON.stringify(foreignChannelBody));
    foreignChannelId = foreignChannelBody.id;

    personalChannelId = uuidv4();
    db.run(
      'INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, NULL)',
      [personalChannelId, 'Personal alerts', 'slack', '{}'],
    );
  });

  after(async () => {
    await close(server);
    await close(targetServer);
    await close(tcpServer);
    if (db) db.close();
  });

  it('denies every app endpoint without a session', async () => {
    const requests: Array<[string, RequestInit]> = [
      ['/api/apps', { method: 'GET' }],
      ['/api/apps', { method: 'POST', body: '{}' }],
      ['/api/apps/example', { method: 'GET' }],
      ['/api/apps/example', { method: 'PATCH', body: '{}' }],
      ['/api/apps/example', { method: 'DELETE' }],
      ['/api/apps/example/test-check', { method: 'POST' }],
    ];
    for (const [path, init] of requests) {
      const response = await apiRequest(path, null, init);
      assert.strictEqual(response.status, 401, `${init.method || 'GET'} ${path}`);
    }
  });

  it('rejects invalid URL, empty name, platform, and check type with field errors', async () => {
    const invalidUrl = await apiRequest('/api/apps', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Valid Name',
        url: 'ftp://example.com/app',
        platform: 'custom',
        alertChannelId: ownChannelId,
      }),
    });
    assert.strictEqual(invalidUrl.status, 400);
    assert.ok((await invalidUrl.json() as any).fields.url);

    const emptyName = await apiRequest('/api/apps', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: '   ',
        url: 'https://example.com/app',
        platform: 'custom',
        alertChannelId: ownChannelId,
      }),
    });
    assert.strictEqual(emptyName.status, 400);
    assert.ok((await emptyName.json() as any).fields.name);

    const invalidPlatform = await apiRequest('/api/apps', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Valid Name',
        url: 'https://example.com/app',
        platform: 'unsupported',
        alertChannelId: ownChannelId,
      }),
    });
    assert.strictEqual(invalidPlatform.status, 400);
    assert.ok((await invalidPlatform.json() as any).fields.platform);

    const invalidCheckType = await apiRequest('/api/apps', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Valid Name',
        url: 'https://example.com/app',
        platform: 'custom',
        checkType: 'dns',
        alertChannelId: ownChannelId,
      }),
    });
    assert.strictEqual(invalidCheckType.status, 400);
    assert.ok((await invalidCheckType.json() as any).fields.checkType);
  });

  it('persists an app with monitoring config and its attached channel', async () => {
    const app = await createApp(ownerToken);
    ownAppId = app.id;
    assert.strictEqual(app.teamId, teamId);
    assert.strictEqual(app.checkType, 'http');
    assert.strictEqual(app.checkTarget, `http://127.0.0.1:${targetPort}`);
    assert.strictEqual(app.checkIntervalSec, 30);
    assert.strictEqual(app.checkTimeoutSec, 2);
    assert.strictEqual(app.enabled, true);
    assert.strictEqual(app.alertChannel.id, ownChannelId);
    assert.strictEqual(app.alertChannel.name, 'Own alerts');

    const stored = db.exec(
      `SELECT team_id, name, url, platform, check_type, check_target, check_interval_sec, check_timeout_sec, enabled, alert_channel_id
       FROM monitored_apps WHERE id = ?`,
      [ownAppId],
    )[0].values[0];
    assert.strictEqual(stored[0], teamId);
    assert.strictEqual(stored[1], 'Customer App');
    assert.strictEqual(stored[5], `http://127.0.0.1:${targetPort}`);
    assert.strictEqual(stored[6], 30);
    assert.strictEqual(stored[7], 2);
    assert.strictEqual(stored[9], ownChannelId);
  });

  it('keeps an attached alert channel from being deleted', async () => {
    const response = await apiRequest(`/api/alerting/channels/${ownChannelId}`, ownerToken, {
      method: 'DELETE',
    });
    assert.strictEqual(response.status, 409);
    assert.strictEqual(
      db.exec('SELECT COUNT(*) FROM alert_channels WHERE id = ?', [ownChannelId])[0].values[0][0],
      1,
    );
  });

  it('does not allow create or alert-channel attachment to cross tenants', async () => {
    const before = db.exec('SELECT COUNT(*) FROM monitored_apps')[0].values[0][0];
    const wrongTeam = await apiRequest('/api/apps', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Wrong Team',
        url: 'https://example.com/app',
        platform: 'custom',
        teamId: otherTeamId,
        alertChannelId: ownChannelId,
      }),
    });
    assert.strictEqual(wrongTeam.status, 403);

    const foreignChannel = await apiRequest('/api/apps', ownerToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Foreign Channel',
        url: 'https://example.com/app',
        platform: 'custom',
        alertChannelId: foreignChannelId,
      }),
    });
    assert.strictEqual(foreignChannel.status, 404);
    const after = db.exec('SELECT COUNT(*) FROM monitored_apps')[0].values[0][0];
    assert.strictEqual(after, before);
  });

  it('lists only applications from the caller tenant', async () => {
    const foreign = await createApp(otherToken, {
      name: 'Foreign App',
      alertChannelId: foreignChannelId,
    });
    foreignAppId = foreign.id;
    assert.strictEqual(foreign.teamId, otherTeamId);

    const ownList = await apiRequest('/api/apps', ownerToken);
    const ownBody = await ownList.json() as any;
    assert.strictEqual(ownList.status, 200);
    assert.ok(ownBody.apps.some((app: any) => app.id === ownAppId));
    assert.ok(!ownBody.apps.some((app: any) => app.id === foreignAppId));

    const foreignList = await apiRequest('/api/apps', otherToken);
    const foreignBody = await foreignList.json() as any;
    assert.ok(foreignBody.apps.some((app: any) => app.id === foreignAppId));
    assert.ok(!foreignBody.apps.some((app: any) => app.id === ownAppId));
  });

  it('does not read or mutate an application from another tenant', async () => {
    const read = await apiRequest(`/api/apps/${foreignAppId}`, ownerToken);
    assert.strictEqual(read.status, 404);

    const update = await apiRequest(`/api/apps/${foreignAppId}`, ownerToken, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.strictEqual(update.status, 404);
    const name = db.exec('SELECT name FROM monitored_apps WHERE id = ?', [foreignAppId])[0].values[0][0];
    assert.strictEqual(name, 'Foreign App');

    const remove = await apiRequest(`/api/apps/${foreignAppId}`, ownerToken, { method: 'DELETE' });
    assert.strictEqual(remove.status, 404);
    assert.strictEqual(db.exec('SELECT COUNT(*) FROM monitored_apps WHERE id = ?', [foreignAppId])[0].values[0][0], 1);
  });

  it('runs one real HTTP request and persists a tenant-scoped snapshot', async () => {
    const requestsBefore = targetRequests;
    const response = await apiRequest(`/api/apps/${ownAppId}/test-check`, ownerToken, { method: 'POST' });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.result.status, 'pass');
    assert.strictEqual(body.result.statusCode, 200);
    assert.ok(body.result.latencyMs >= 0);
    assert.strictEqual(body.result.errorType, null);
    assert.strictEqual(targetRequests - requestsBefore, 1);

    const snapshot = db.exec(
      'SELECT app_id, team_id, status, status_code, latency_ms, error_type FROM health_snapshots WHERE id = ?',
      [body.result.id],
    )[0].values[0];
    assert.strictEqual(snapshot[0], ownAppId);
    assert.strictEqual(snapshot[1], teamId);
    assert.strictEqual(snapshot[2], 'pass');
    assert.strictEqual(snapshot[3], 200);

    const appResponse = await apiRequest(`/api/apps/${ownAppId}`, ownerToken);
    const appBody = await appResponse.json() as any;
    assert.strictEqual(appBody.app.latestHealth.id, body.result.id);
  });

  it('returns a real connection failure for an unreachable local endpoint', async () => {
    const closedServer = createServer();
    const closedPort = await listen(closedServer);
    await close(closedServer);

    const app = await createApp(ownerToken, {
      name: 'Unreachable App',
      url: `http://127.0.0.1:${closedPort}`,
      checkTarget: `http://127.0.0.1:${closedPort}`,
      checkTimeoutSec: 1,
    });
    const response = await apiRequest(`/api/apps/${app.id}/test-check`, ownerToken, { method: 'POST' });
    const body = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.result.status, 'fail');
    assert.strictEqual(body.result.statusCode, null);
    assert.strictEqual(body.result.errorType, 'connection_refused');
    assert.ok(body.result.errorDetail);

    const snapshot = db.exec(
      'SELECT status, error_type, team_id FROM health_snapshots WHERE id = ?',
      [body.result.id],
    )[0].values[0];
    assert.strictEqual(snapshot[0], 'fail');
    assert.strictEqual(snapshot[1], 'connection_refused');
    assert.strictEqual(snapshot[2], teamId);
  });

  it('classifies real 4xx, 5xx, and timeout failures', async () => {
    const missing = await createApp(ownerToken, {
      name: '4xx App',
      url: `http://127.0.0.1:${targetPort}/missing`,
      checkTarget: `http://127.0.0.1:${targetPort}/missing`,
    });
    const missingResponse = await apiRequest(`/api/apps/${missing.id}/test-check`, ownerToken, { method: 'POST' });
    const missingBody = await missingResponse.json() as any;
    assert.strictEqual(missingBody.result.status, 'fail');
    assert.strictEqual(missingBody.result.statusCode, 404);
    assert.strictEqual(missingBody.result.errorType, 'http_4xx');

    const failure = await createApp(ownerToken, {
      name: '5xx App',
      url: `http://127.0.0.1:${targetPort}/failure`,
      checkTarget: `http://127.0.0.1:${targetPort}/failure`,
    });
    const failureResponse = await apiRequest(`/api/apps/${failure.id}/test-check`, ownerToken, { method: 'POST' });
    const failureBody = await failureResponse.json() as any;
    assert.strictEqual(failureBody.result.status, 'fail');
    assert.strictEqual(failureBody.result.statusCode, 500);
    assert.strictEqual(failureBody.result.errorType, 'http_5xx');

    const slow = await createApp(ownerToken, {
      name: 'Timeout App',
      url: `http://127.0.0.1:${targetPort}/slow`,
      checkTarget: `http://127.0.0.1:${targetPort}/slow`,
      checkTimeoutSec: 1,
    });
    const slowResponse = await apiRequest(`/api/apps/${slow.id}/test-check`, ownerToken, { method: 'POST' });
    const slowBody = await slowResponse.json() as any;
    assert.strictEqual(slowBody.result.status, 'fail');
    assert.strictEqual(slowBody.result.statusCode, null);
    assert.strictEqual(slowBody.result.errorType, 'timeout');
  });

  it('executes keyword checks and reports a missing keyword', async () => {
    const app = await createApp(ownerToken, {
      name: 'Keyword App',
      checkType: 'keyword',
      checkTarget: `http://127.0.0.1:${targetPort}`,
      keyword: 'nightlamp-ok',
    });
    const success = await apiRequest(`/api/apps/${app.id}/test-check`, ownerToken, { method: 'POST' });
    const successBody = await success.json() as any;
    assert.strictEqual(successBody.result.status, 'pass');
    assert.strictEqual(successBody.result.statusCode, 200);

    const update = await apiRequest(`/api/apps/${app.id}`, ownerToken, {
      method: 'PATCH',
      body: JSON.stringify({ keyword: 'not-present' }),
    });
    assert.strictEqual(update.status, 200);

    const failure = await apiRequest(`/api/apps/${app.id}/test-check`, ownerToken, { method: 'POST' });
    const failureBody = await failure.json() as any;
    assert.strictEqual(failureBody.result.status, 'fail');
    assert.strictEqual(failureBody.result.statusCode, 200);
    assert.strictEqual(failureBody.result.errorType, 'keyword_not_found');
  });

  it('executes a real TCP check', async () => {
    const app = await createApp(ownerToken, {
      name: 'TCP App',
      checkType: 'tcp',
      checkTarget: `127.0.0.1:${tcpPort}`,
    });
    const response = await apiRequest(`/api/apps/${app.id}/test-check`, ownerToken, { method: 'POST' });
    const body = await response.json() as any;
    assert.strictEqual(body.result.status, 'pass');
    assert.strictEqual(body.result.statusCode, null);
    assert.strictEqual(body.result.errorType, null);
  });

  it('keeps legacy null-team applications visible only in personal scope', async () => {
    const legacyId = uuidv4();
    db.run(
      `INSERT INTO monitored_apps (
        id, team_id, name, url, platform, check_type, check_target,
        check_interval_sec, check_timeout_sec, enabled, alert_channel_id
      ) VALUES (?, NULL, ?, ?, 'custom', 'http', ?, 60, 10, 1, ?)`,
      [legacyId, 'Legacy App', 'https://example.com/legacy', 'https://example.com/legacy', personalChannelId],
    );

    const personalList = await apiRequest('/api/apps', personalToken);
    const personalBody = await personalList.json() as any;
    assert.ok(personalBody.apps.some((app: any) => app.id === legacyId));

    const personalRead = await apiRequest(`/api/apps/${legacyId}`, personalToken);
    assert.strictEqual(personalRead.status, 200);

    const teamList = await apiRequest('/api/apps', ownerToken);
    const teamBody = await teamList.json() as any;
    assert.ok(!teamBody.apps.some((app: any) => app.id === legacyId));

    const teamRead = await apiRequest(`/api/apps/${legacyId}`, ownerToken);
    assert.strictEqual(teamRead.status, 404);
  });

  it('updates and deletes an owned application without touching another tenant', async () => {
    const update = await apiRequest(`/api/apps/${ownAppId}`, ownerToken, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated App', enabled: false }),
    });
    const updateBody = await update.json() as any;
    assert.strictEqual(update.status, 200, JSON.stringify(updateBody));
    assert.strictEqual(updateBody.app.name, 'Updated App');
    assert.strictEqual(updateBody.app.enabled, false);

    const remove = await apiRequest(`/api/apps/${ownAppId}`, ownerToken, { method: 'DELETE' });
    assert.strictEqual(remove.status, 200);
    assert.strictEqual(db.exec('SELECT COUNT(*) FROM monitored_apps WHERE id = ?', [ownAppId])[0].values[0][0], 0);
    assert.strictEqual(db.exec('SELECT COUNT(*) FROM monitored_apps WHERE id = ?', [foreignAppId])[0].values[0][0], 1);
  });
});
