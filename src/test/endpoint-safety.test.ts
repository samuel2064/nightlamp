import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase, saveDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { repairAppIntegrity } from '../apps/integrity';
import { createTestToken, fetchWithoutAuth } from './setup';
import {
  EndpointCheckConfig,
  EndpointCheckDeps,
  assertTargetAllowed,
  parseTcpTarget,
  runEndpointCheck,
} from '../engine/endpoint-check';
import {
  BlockedTargetError,
  TargetResolutionError,
  isBlockedAddress,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  resolvePublicTarget,
} from '../engine/outbound-safety';

describe('outbound target safety', () => {
  it('blocks loopback, private, link-local, and reserved IPv4 ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '192.168.1.10',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
    ]) {
      assert.ok(isBlockedIpv4(address), `${address} must be blocked`);
      assert.ok(isBlockedAddress(address), `${address} must be blocked`);
    }
    assert.ok(!isBlockedIpv4('93.184.216.34'));
    assert.ok(!isBlockedAddress('93.184.216.34'));
  });

  it('blocks IPv6 loopback, unique-local, link-local, and mapped loopback', () => {
    for (const address of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.ok(isBlockedIpv6(address), `${address} must be blocked`);
      assert.ok(isBlockedAddress(address), `${address} must be blocked`);
    }
    assert.ok(!isBlockedIpv6('2606:2800:220:1:248:1893:25c8:1946'));
  });

  it('blocks metadata and loopback hostnames', () => {
    for (const host of [
      'localhost',
      'LOCALHOST',
      'metadata.google.internal',
      'instance-data.ec2.internal',
      'host.docker.internal',
      'api.localhost',
    ]) {
      assert.ok(isBlockedHostname(host), `${host} must be blocked`);
    }
    assert.ok(!isBlockedHostname('example.com'));
  });

  it('rejects a hostname that resolves to a private address', async () => {
    await assert.rejects(
      () => resolvePublicTarget('internal.example.com', async () => ['10.1.2.3']),
      (error: any) => error instanceof BlockedTargetError,
    );
  });

  it('surfaces resolver failures as a DNS failure', async () => {
    await assert.rejects(
      () => resolvePublicTarget('missing.example.com', async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      }),
      (error: any) => error instanceof TargetResolutionError,
    );
  });

  it('pins every resolved address so the request cannot be rebound', async () => {
    const resolver = async () => ['93.184.216.34', '93.184.216.35'];
    const resolved = await resolvePublicTarget('example.com', resolver);
    assert.deepStrictEqual(resolved.addresses, ['93.184.216.34', '93.184.216.35']);

    let seen: string[] = [];
    const result = await runEndpointCheck(
      { type: 'http', target: 'https://example.com/health', timeoutMs: 5000 },
      {
        resolver,
        httpTransport: async (request) => {
          seen = request.addresses;
          return { statusCode: 200, body: null, bodyTruncated: false };
        },
      },
    );
    assert.strictEqual(result.status, 'pass');
    assert.deepStrictEqual(seen, ['93.184.216.34', '93.184.216.35']);
  });

  it('reports a blocked destination instead of issuing the request', async () => {
    let called = false;
    const result = await runEndpointCheck(
      { type: 'http', target: 'http://127.0.0.1:8080/health', timeoutMs: 5000 },
      {
        httpTransport: async () => {
          called = true;
          return { statusCode: 200, body: null, bodyTruncated: false };
        },
      },
    );
    assert.strictEqual(called, false);
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.errorType, 'blocked_target');
  });

  it('reports a DNS failure when the target cannot be resolved', async () => {
    const result = await runEndpointCheck(
      { type: 'http', target: 'https://missing.example.com/health', timeoutMs: 5000 },
      {
        resolver: async () => {
          throw Object.assign(new Error('nope'), { code: 'EAI_AGAIN' });
        },
      },
    );
    assert.strictEqual(result.status, 'fail');
    assert.strictEqual(result.errorType, 'dns_failure');
  });

  it('classifies transport failures into stable error types', async () => {
    const cases: Array<[string, string]> = [
      ['ETIMEDOUT', 'timeout'],
      ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
      ['ECONNREFUSED', 'connection_refused'],
      ['EAI_FAIL', 'dns_failure'],
      ['ENOTFOUND', 'dns_failure'],
      ['ECONNRESET', 'connection_error'],
      ['EHOSTUNREACH', 'connection_error'],
    ];

    for (const [code, expected] of cases) {
      const result = await runEndpointCheck(
        { type: 'http', target: 'https://example.com/health', timeoutMs: 5000 },
        {
          resolver: async () => ['93.184.216.34'],
          httpTransport: async () => {
            throw Object.assign(new Error('failed'), { code });
          },
        },
      );
      assert.strictEqual(result.errorType, expected, `${code} must map to ${expected}`);
    }
  });

  it('classifies HTTP status failures and oversized keyword bodies', async () => {
    const clientError = await runEndpointCheck(
      { type: 'http', target: 'https://example.com/health', timeoutMs: 5000 },
      {
        resolver: async () => ['93.184.216.34'],
        httpTransport: async () => ({ statusCode: 404, body: null, bodyTruncated: false }),
      },
    );
    assert.strictEqual(clientError.errorType, 'http_4xx');

    const serverError = await runEndpointCheck(
      { type: 'http', target: 'https://example.com/health', timeoutMs: 5000 },
      {
        resolver: async () => ['93.184.216.34'],
        httpTransport: async () => ({ statusCode: 503, body: null, bodyTruncated: false }),
      },
    );
    assert.strictEqual(serverError.errorType, 'http_5xx');

    const oversized = await runEndpointCheck(
      { type: 'keyword', target: 'https://example.com/health', timeoutMs: 5000, keyword: 'ok' },
      {
        resolver: async () => ['93.184.216.34'],
        httpTransport: async () => ({ statusCode: 200, body: Buffer.from('ok'), bodyTruncated: true }),
      },
    );
    assert.strictEqual(oversized.errorType, 'response_too_large');
  });

  it('rejects private targets through the shared assertion helper', async () => {
    await assert.rejects(
      () => assertTargetAllowed('http://169.254.169.254/latest/meta-data', 'http'),
      (error: any) => error instanceof BlockedTargetError,
    );
    await assert.rejects(
      () => assertTargetAllowed('tcp://127.0.0.1:22', 'tcp'),
      (error: any) => error instanceof BlockedTargetError,
    );
    await assertTargetAllowed('https://example.com/health', 'http');
  });

  it('rejects malformed TCP targets', () => {
    assert.deepStrictEqual(parseTcpTarget('example.com:443'), { host: 'example.com', port: 443 });
    assert.deepStrictEqual(parseTcpTarget('tcp://example.com:443'), { host: 'example.com', port: 443 });
    assert.strictEqual(parseTcpTarget('example.com'), null);
    assert.strictEqual(parseTcpTarget('example.com:0'), null);
    assert.strictEqual(parseTcpTarget('example.com:70000'), null);
    assert.strictEqual(parseTcpTarget('example.com:not-a-port'), null);
  });
});

describe('monitored app safety controls', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let openServer: Server;
  let openPort: number;
  let teamId: string;
  let channelId: string;
  let resolverCalls: string[];
  let runCheckCalls: EndpointCheckConfig[];

  const ownerToken = createTestToken({ sub: 'safety-clerk', email: 'safety@example.com' });

  const endpointDeps: EndpointCheckDeps = {
    resolver: async (host: string) => {
      resolverCalls.push(host);
      if (host === 'private.example.com') return ['192.168.10.10'];
      if (host === 'broken.example.com') {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      }
      return ['93.184.216.34'];
    },
  };

  async function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${ownerToken}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  }

  async function createApp(overrides: Record<string, unknown>): Promise<Response> {
    return apiRequest('/api/apps', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Safety App',
        url: 'https://example.com/app',
        platform: 'custom',
        checkType: 'http',
        checkTarget: 'https://example.com/health',
        checkIntervalSec: 30,
        checkTimeoutSec: 2,
        enabled: true,
        alertChannelId: channelId,
        ...overrides,
      }),
    });
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'safety-user',
      'safety-clerk',
      'safety@example.com',
      'Safety',
    ]);
    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)', [
      teamId,
      'Safety Team',
      `safety-${teamId.slice(0, 8)}`,
      'safety-user',
      'free',
    ]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [
      uuidv4(),
      teamId,
      'safety-user',
      'owner',
    ]);

    resolverCalls = [];
    runCheckCalls = [];
    server = startApiServer(db, {
      port: 0,
      appsApiDeps: {
        endpointDeps,
        runCheck: async (config: EndpointCheckConfig) => {
          runCheckCalls.push(config);
          return {
            status: 'pass',
            statusCode: 200,
            latencyMs: 12.5,
            errorType: null,
            errorDetail: null,
          };
        },
      },
    });
    port = (server.address() as { port: number }).port;

    openServer = startApiServer(db, {
      port: 0,
      appsApiDeps: {
        endpointDeps,
        cooldownMs: 0,
        runCheck: async (config: EndpointCheckConfig) => {
          runCheckCalls.push(config);
          return {
            status: 'pass',
            statusCode: 200,
            latencyMs: 1,
            errorType: null,
            errorDetail: null,
          };
        },
      },
    });
    openPort = (openServer.address() as { port: number }).port;

    const channel = db.exec(
      "INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Safety', 'slack', '{}', ?)",
      [uuidv4(), teamId],
    );
    channelId = db.exec('SELECT id FROM alert_channels ORDER BY created_at DESC LIMIT 1')[0].values[0][0];
  });

  after(async () => {
    if (server.listening) server.close();
    if (openServer.listening) openServer.close();
    if (db) db.close();
  });

  it('rejects loopback, metadata, and hostname-based SSRF targets on create', async () => {
    const loopback = await createApp({ checkTarget: 'http://127.0.0.1:8080/health' });
    assert.strictEqual(loopback.status, 400);
    const loopbackBody = await loopback.json() as any;
    assert.ok(loopbackBody.fields.checkTarget);

    const metadata = await createApp({ checkTarget: 'http://169.254.169.254/latest/meta-data' });
    assert.strictEqual(metadata.status, 400);

    const localHost = await createApp({ checkTarget: 'http://localhost:8080/health' });
    assert.strictEqual(localHost.status, 400);

    const privateDns = await createApp({ checkTarget: 'https://private.example.com/health' });
    assert.strictEqual(privateDns.status, 400);

    const dnsFailure = await createApp({ checkTarget: 'https://broken.example.com/health' });
    assert.strictEqual(dnsFailure.status, 400);
  });

  it('rejects a blocked target on update', async () => {
    const created = await createApp({});
    assert.strictEqual(created.status, 201);
    const body = await created.json() as any;

    const updated = await apiRequest(`/api/apps/${body.app.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ checkTarget: 'http://10.0.0.5/health' }),
    });
    assert.strictEqual(updated.status, 400);
    const updatedBody = await updated.json() as any;
    assert.ok(updatedBody.fields.checkTarget);
  });

  it('rejects malformed and unsafe identifiers and payloads with 4xx field errors', async () => {
    const malformedId = await apiRequest('/api/apps/%E0%A4%A/test-check', { method: 'POST' });
    assert.strictEqual(malformedId.status, 400);

    const tcpPath = await createApp({ checkType: 'tcp', checkTarget: 'example.com:443/path' });
    assert.strictEqual(tcpPath.status, 400);

    const tcpCredentials = await createApp({ checkType: 'tcp', checkTarget: 'user:pass@example.com:443' });
    assert.strictEqual(tcpCredentials.status, 400);

    const whitespaceUrl = await createApp({ url: 'https://example.com/a b' });
    assert.strictEqual(whitespaceUrl.status, 400);

    const longUrl = await createApp({ url: `https://example.com/${'a'.repeat(3000)}` });
    assert.strictEqual(longUrl.status, 400);

    const controlName = await createApp({ name: 'Bad\u0000Name' });
    assert.strictEqual(controlName.status, 400);
  });

  it('runs the check for the stored target and stores the snapshot', async () => {
    const created = await createApp({ checkTarget: 'https://example.com/ready' });
    const body = await created.json() as any;

    const response = await apiRequest(`/api/apps/${body.app.id}/test-check`, { method: 'POST' });
    const result = await response.json() as any;
    assert.strictEqual(response.status, 200, JSON.stringify(result));
    assert.strictEqual(result.result.status, 'pass');
    assert.strictEqual(runCheckCalls[runCheckCalls.length - 1].target, 'https://example.com/ready');

    const snapshot = db.exec('SELECT app_id, status FROM health_snapshots WHERE id = ?', [result.result.id])[0].values[0];
    assert.strictEqual(snapshot[0], body.app.id);
    assert.strictEqual(snapshot[1], 'pass');
  });

  it('rate limits repeated checks with a 429 and a Retry-After header', async () => {
    const created = await createApp({});
    const body = await created.json() as any;

    const first = await apiRequest(`/api/apps/${body.app.id}/test-check`, { method: 'POST' });
    assert.strictEqual(first.status, 200);

    const second = await apiRequest(`/api/apps/${body.app.id}/test-check`, { method: 'POST' });
    assert.strictEqual(second.status, 429);
    assert.ok(second.headers.get('Retry-After'));
    const secondBody = await second.json() as any;
    assert.ok(secondBody.error);
    assert.ok(secondBody.retryAfterSec >= 1);
  });

  it('rejects a concurrent check for the same app', async () => {
    const created = await createApp({});
    const body = await created.json() as any;

    const slowServer = startApiServer(db, {
      port: 0,
      appsApiDeps: {
        endpointDeps,
        runCheck: async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return {
            status: 'pass',
            statusCode: 200,
            latencyMs: 150,
            errorType: null,
            errorDetail: null,
          };
        },
      },
    });
    const slowPort = (slowServer.address() as { port: number }).port;

    const request = () => fetchWithoutAuth(`http://127.0.0.1:${slowPort}/api/apps/${body.app.id}/test-check`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const responses = await Promise.all([request(), request()]);
    const statuses = responses.map((response) => response.status).sort();
    assert.deepStrictEqual(statuses, [200, 429]);
    slowServer.close();
  });

  it('bounds retained snapshots per app', async () => {
    const created = await fetchWithoutAuth(`http://127.0.0.1:${openPort}/api/apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Retention App',
        url: 'https://example.com/app',
        platform: 'custom',
        checkType: 'http',
        checkTarget: 'https://example.com/health',
        checkIntervalSec: 30,
        checkTimeoutSec: 2,
        enabled: true,
        alertChannelId: channelId,
      }),
    });
    const createdBody = await created.json() as any;
    assert.strictEqual(created.status, 201, JSON.stringify(createdBody));

    for (let index = 0; index < 105; index += 1) {
      const response = await fetchWithoutAuth(`http://127.0.0.1:${openPort}/api/apps/${createdBody.app.id}/test-check`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.strictEqual(response.status, 200);
    }

    const count = db.exec(
      'SELECT COUNT(*) FROM health_snapshots WHERE app_id = ?',
      [createdBody.app.id],
    )[0].values[0][0];
    assert.ok(count <= 100, `expected at most 100 snapshots, found ${count}`);
  });
});

describe('personal ownership isolation', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let legacyChannelId: string;

  const personalA = createTestToken({ sub: 'personal-a-clerk', email: 'a@example.com' });
  const personalB = createTestToken({ sub: 'personal-b-clerk', email: 'b@example.com' });

  async function apiRequest(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    return fetchWithoutAuth(`http://127.0.0.1:${port}${path}`, { ...init, headers });
  }

  before(async () => {
    db = await createDatabase();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'personal-a-user', 'personal-a-clerk', 'a@example.com', 'Personal A',
    ]);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'personal-b-user', 'personal-b-clerk', 'b@example.com', 'Personal B',
    ]);

    legacyChannelId = uuidv4();
    db.run(
      'INSERT INTO alert_channels (id, name, type, config, team_id, owner_id) VALUES (?, ?, ?, ?, NULL, NULL)',
      [legacyChannelId, 'Legacy personal channel', 'slack', '{}'],
    );

    server = startApiServer(db, { port: 0 });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    if (server.listening) server.close();
    if (db) db.close();
  });

  it('keeps a personal channel invisible to other personal users', async () => {
    const created = await apiRequest('/api/notifications/channels', personalA, {
      method: 'POST',
      body: JSON.stringify({ name: 'Personal A channel', type: 'slack-webhook', config: { webhookUrl: 'https://example.invalid/a' } }),
    });
    assert.strictEqual(created.status, 200);
    const body = await created.json() as any;

    const owner = db.exec('SELECT owner_id FROM alert_channels WHERE id = ?', [body.id]);
    assert.strictEqual(owner[0].values[0][0], 'personal-a-user');

    const otherList = await apiRequest('/api/notifications/channels', personalB);
    const otherBody = await otherList.json() as any;
    assert.ok(!otherBody.channels.some((channel: any) => channel.id === body.id));
    assert.ok(!otherBody.channels.some((channel: any) => channel.id === legacyChannelId));

    const ownerList = await apiRequest('/api/notifications/channels', personalA);
    const ownerBody = await ownerList.json() as any;
    assert.ok(ownerBody.channels.some((channel: any) => channel.id === body.id));
    assert.ok(!ownerBody.channels.some((channel: any) => channel.id === legacyChannelId));
  });

  it('refuses to mutate a personal channel owned by another user', async () => {
    const created = await apiRequest('/api/notifications/channels', personalA, {
      method: 'POST',
      body: JSON.stringify({ name: 'Owned channel', type: 'slack-webhook', config: { webhookUrl: 'https://example.invalid/owned' } }),
    });
    const body = await created.json() as any;

    const update = await apiRequest(`/api/notifications/channels/${body.id}`, personalB, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.strictEqual(update.status, 404);

    const remove = await apiRequest(`/api/notifications/channels/${body.id}`, personalB, { method: 'DELETE' });
    assert.strictEqual(remove.status, 404);

    const name = db.exec('SELECT name FROM alert_channels WHERE id = ?', [body.id]);
    assert.strictEqual(name[0].values[0][0], 'Owned channel');
  });

  it('hides legacy personal rows from every scope', async () => {
    const list = await apiRequest('/api/notifications/channels', personalA);
    const listBody = await list.json() as any;
    assert.ok(!listBody.channels.some((channel: any) => channel.id === legacyChannelId));

    const update = await apiRequest(`/api/notifications/channels/${legacyChannelId}`, personalA, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Legacy rename' }),
    });
    assert.strictEqual(update.status, 404);

    const remove = await apiRequest(`/api/notifications/channels/${legacyChannelId}`, personalA, { method: 'DELETE' });
    assert.strictEqual(remove.status, 404);

    const legacyAppId = uuidv4();
    db.run(
      `INSERT INTO monitored_apps (
        id, team_id, owner_id, name, url, platform, check_type, check_target,
        check_interval_sec, check_timeout_sec, enabled, alert_channel_id
      ) VALUES (?, NULL, NULL, 'Legacy personal app', 'https://example.com', 'custom', 'http',
        'https://example.com/health', 60, 10, 1, ?)`,
      [legacyAppId, legacyChannelId],
    );

    const read = await apiRequest(`/api/apps/${legacyAppId}`, personalA);
    assert.strictEqual(read.status, 404);

    const updateApp = await apiRequest(`/api/apps/${legacyAppId}`, personalA, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Legacy app rename' }),
    });
    assert.strictEqual(updateApp.status, 404);

    const removeApp = await apiRequest(`/api/apps/${legacyAppId}`, personalA, { method: 'DELETE' });
    assert.strictEqual(removeApp.status, 404);
  });
});

describe('durable persistence and referential integrity', () => {
  it('loads the existing database file from the configured path and writes it atomically', async () => {
    const directory = path.join(os.tmpdir(), `nightlamp-noc283-${Date.now()}-${process.pid}`);
    fs.mkdirSync(directory, { recursive: true });
    const dbPath = path.join(directory, 'nightlamp.db');

    const first = await createDatabase(dbPath);
    first.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [
      'persisted-user',
      'persisted-clerk',
      'persisted@example.com',
      'Persisted',
    ]);
    saveDatabase(first, dbPath);
    first.close();

    const second = await createDatabase(dbPath);
    const rows = second.exec('SELECT id FROM users WHERE id = ?', ['persisted-user']);
    assert.strictEqual(rows[0].values.length, 1);
    second.close();

    const leftovers = fs.readdirSync(directory).filter((name) => name.includes('.tmp'));
    assert.deepStrictEqual(leftovers, []);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects an application row that references a missing alert channel', async () => {
    const db = await createDatabase();
    db.run('PRAGMA foreign_keys = ON');
    assert.throws(() => {
      db.run(
        `INSERT INTO monitored_apps (
          id, team_id, owner_id, name, url, platform, check_type, check_target,
          check_interval_sec, check_timeout_sec, enabled, alert_channel_id
        ) VALUES ('app-orphan', NULL, 'user-1', 'Orphan', 'https://example.com', 'custom', 'http',
          'https://example.com/health', 60, 10, 1, 'missing-channel')`,
      );
    });
    db.close();
  });

  it('repairs orphaned snapshots and disables applications with a missing channel', async () => {
    const db = await createDatabase();
    db.run(
      `INSERT INTO monitored_apps (
        id, team_id, owner_id, name, url, platform, check_type, check_target,
        check_interval_sec, check_timeout_sec, enabled, alert_channel_id
      ) VALUES ('app-no-channel', NULL, 'user-1', 'No Channel', 'https://example.com', 'custom', 'http',
        'https://example.com/health', 60, 10, 1, 'missing-channel')`,
    );
    db.run(
      `INSERT INTO health_snapshots (id, app_id, team_id, status, latency_ms)
       VALUES ('snapshot-orphan', 'app-missing', NULL, 'pass', 1)`,
    );

    const report = repairAppIntegrity(db);
    assert.strictEqual(report.orphanedSnapshotsRemoved, 1);
    assert.strictEqual(report.orphanedAppsDisabled, 1);

    const snapshots = db.exec('SELECT COUNT(*) FROM health_snapshots WHERE id = ?', ['snapshot-orphan']);
    assert.strictEqual(snapshots[0].values[0][0], 0);
    const app = db.exec('SELECT enabled FROM monitored_apps WHERE id = ?', ['app-no-channel']);
    assert.strictEqual(app[0].values[0][0], 0);
    db.close();
  });
});
