import assert from 'assert';
import * as fs from 'fs';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { ensureCheck, runSentryCheck, runUptimeRobotCheck } from '../engine';
import { evaluateSelfMonitor, readSelfMonitorMetrics } from '../alerting';

function rows(db: Database, sql: string, params: any[] = []): any[] {
  const result = db.exec(sql, params);
  return result.length > 0 ? result[0].values : [];
}

describe('Tenant monitor attribution', function () {
  let db: Database;
  let server: Server;
  let captureUrl: string;
  let received: string[];
  let originalFetch: typeof globalThis.fetch;
  let playbookDir: string;

  beforeEach(async function () {
    db = await createDatabase();
    received = [];
    originalFetch = globalThis.fetch;
    playbookDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlamp-noc246-'));
    server = createServer((req, res) => {
      received.push(req.url || '');
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address() as AddressInfo;
    captureUrl = `http://127.0.0.1:${address.port}/notify`;
  });

  afterEach(function () {
    globalThis.fetch = originalFetch;
    db.close();
    fs.rmSync(playbookDir, { recursive: true, force: true });
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function insertRouting(channelId: string, ruleId: string, teamId: string, failureType: string): void {
    db.run(
      `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, 'in-app-websocket', ?, ?)`,
      [channelId, `${teamId} channel`, JSON.stringify({ url: captureUrl, reconnect: false }), teamId],
    );
    db.run(
      `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity, team_id) VALUES (?, ?, ?, ?, 'info', ?)`,
      [ruleId, `${teamId} rule`, channelId, JSON.stringify([failureType]), teamId],
    );
  }

  function stubSentryFailure(): void {
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url?.startsWith('https://sentry.io/')) {
        return {
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: async () => [],
          text: async () => 'server error',
        } as any;
      }
      if (url === captureUrl) {
        return originalFetch(input, init);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  }

  function stubUptimeRobotDown(): void {
    globalThis.fetch = (async (input: any, init: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (url === 'https://api.uptimerobot.com/v2/getMonitors') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            stat: 'ok',
            monitors: [{
              id: 1,
              friendly_name: 'Tenant App',
              url: 'https://tenant.example',
              type: 1,
              status: 9,
              interval: 300,
              create_datetime: 0,
              response_times: [],
            }],
          }),
          text: async () => 'ok',
        } as any;
      }
      if (url === captureUrl) {
        return originalFetch(input, init);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof globalThis.fetch;
  }

  it('keeps monitor identity scoped by tenant and leaves legacy personal rows unclaimed', function () {
    db.run(
      `INSERT INTO checks (id, source, name, config, enabled, team_id) VALUES (?, 'sentry', 'Sentry Error Monitor', '{}', 1, NULL)`,
      ['legacy-check'],
    );

    const tenantCheck = ensureCheck(db, 'sentry', 'Sentry Error Monitor', { authToken: 'tenant-token' }, 'tenant-a');
    const sameTenantCheck = ensureCheck(db, 'sentry', 'Sentry Error Monitor', { authToken: 'tenant-token' }, 'tenant-a');
    const otherTenantCheck = ensureCheck(db, 'sentry', 'Sentry Error Monitor', { authToken: 'other-token' }, 'tenant-b');

    assert.strictEqual(tenantCheck, sameTenantCheck);
    assert.notStrictEqual(tenantCheck, otherTenantCheck);
    assert.notStrictEqual(tenantCheck, 'legacy-check');
    assert.strictEqual(rows(db, 'SELECT team_id FROM checks WHERE id = ?', ['legacy-check'])[0][0], null);
    assert.strictEqual(rows(db, 'SELECT team_id FROM checks WHERE id = ?', [tenantCheck])[0][0], 'tenant-a');
    assert.strictEqual(rows(db, 'SELECT team_id FROM checks WHERE id = ?', [otherTenantCheck])[0][0], 'tenant-b');
  });

  it('routes a tenant poller event only to that tenant and never to personal scope', async function () {
    insertRouting('tenant-a-channel', 'tenant-a-rule', 'tenant-a', 'broken_webhook');
    insertRouting('tenant-b-channel', 'tenant-b-rule', 'tenant-b', 'broken_webhook');
    stubSentryFailure();

    const tenantRun = await runSentryCheck(
      db,
      { authToken: 'tenant-token', orgSlug: 'tenant-org', projectSlug: 'tenant-project' },
      [],
      playbookDir,
      'tenant-a',
    );

    assert.strictEqual(tenantRun.failureEvents, 1);
    assert.strictEqual(rows(db, 'SELECT team_id FROM checks WHERE id = ?', [tenantRun.checkId])[0][0], 'tenant-a');
    assert.ok(rows(db, 'SELECT team_id FROM check_results WHERE check_id = ?', [tenantRun.checkId]).every((row: any) => row[0] === 'tenant-a'));
    assert.ok(rows(db, 'SELECT team_id FROM failure_events WHERE check_id = ?', [tenantRun.checkId]).every((row: any) => row[0] === 'tenant-a'));

    const tenantLogs = rows(db, 'SELECT rule_id FROM alert_log').map((row: any) => row[0]);
    assert.deepStrictEqual(tenantLogs, ['tenant-a-rule']);
    assert.strictEqual(received.length, 1);

    const personalRun = await runSentryCheck(
      db,
      { authToken: 'platform-token', orgSlug: 'platform-org', projectSlug: 'platform-project' },
      [],
      playbookDir,
      null,
    );

    assert.strictEqual(personalRun.failureEvents, 1);
    assert.strictEqual(rows(db, 'SELECT team_id FROM checks WHERE id = ?', [personalRun.checkId])[0][0], null);
    assert.ok(rows(db, 'SELECT team_id FROM check_results WHERE check_id = ?', [personalRun.checkId]).every((row: any) => row[0] === null));
    assert.ok(rows(db, 'SELECT team_id FROM failure_events WHERE check_id = ?', [personalRun.checkId]).every((row: any) => row[0] === null));
    assert.deepStrictEqual(rows(db, 'SELECT rule_id FROM alert_log').map((row: any) => row[0]), ['tenant-a-rule']);
    assert.strictEqual(received.length, 1);
  });

  it('propagates tenant ownership through UptimeRobot monitor events', async function () {
    insertRouting('tenant-uptime-channel', 'tenant-uptime-rule', 'tenant-a', 'broken_webhook');
    insertRouting('other-uptime-channel', 'other-uptime-rule', 'tenant-b', 'broken_webhook');
    stubUptimeRobotDown();

    const result = await runUptimeRobotCheck(
      db,
      { apiKey: 'tenant-api-key' },
      [],
      playbookDir,
      'tenant-a',
    );

    assert.strictEqual(result.failureEvents, 1);
    assert.strictEqual(rows(db, 'SELECT team_id FROM checks WHERE id = ?', [result.checkId])[0][0], 'tenant-a');
    assert.ok(rows(db, 'SELECT team_id FROM check_results WHERE check_id = ?', [result.checkId]).every((row: any) => row[0] === 'tenant-a'));
    assert.ok(rows(db, 'SELECT team_id FROM failure_events WHERE check_id = ?', [result.checkId]).every((row: any) => row[0] === 'tenant-a'));
    assert.deepStrictEqual(rows(db, 'SELECT rule_id FROM alert_log').map((row: any) => row[0]), ['tenant-uptime-rule']);
    assert.strictEqual(received.length, 1);
  });

  it('keeps platform self-monitoring in personal scope and out of customer channels', async function () {
    insertRouting('tenant-slo-channel', 'tenant-slo-rule', 'tenant-a', 'slo_breach');
    db.run(
      `INSERT INTO check_results (id, check_id, status, summary, team_id) VALUES (?, ?, 'failed', 'platform failure', NULL)`,
      ['personal-failure', 'personal-check'],
    );
    db.run(
      `INSERT INTO check_results (id, check_id, status, summary, team_id) VALUES (?, ?, 'failed', 'tenant failure', ?)`,
      ['tenant-failure', 'tenant-check', 'tenant-a'],
    );

    const metrics = readSelfMonitorMetrics(db, { global: { count: 0, p50: 0, p95: 10, p99: 0, max: 0, avg: 0 } }, 24);
    assert.strictEqual(metrics.errorRate, 1);

    const result = await evaluateSelfMonitor(
      db,
      { global: { count: 0, p50: 0, p95: 1000, p99: 0, max: 0, avg: 0 } },
      { checkId: 'self-monitor-1' },
    );

    assert.strictEqual(result.anyBreached, true);
    const selfMonitorEvents = rows(db, `SELECT team_id FROM failure_events WHERE failure_type = 'slo_breach'`);
    assert.strictEqual(selfMonitorEvents.length, 1);
    assert.strictEqual(selfMonitorEvents[0][0], null);
    assert.strictEqual(rows(db, 'SELECT rule_id FROM alert_log').length, 0);
    assert.strictEqual(received.length, 0);
  });
});
