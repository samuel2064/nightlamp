import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Server } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase, saveDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { createTestToken, fetchWithoutAuth } from './setup';

async function request(
  server: Server,
  path: string,
  token: string | null,
  init: RequestInit = {},
): Promise<{ status: number; body: any }> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetchWithoutAuth(`http://127.0.0.1:${(server.address() as any).port}${path}`, {
    ...init,
    headers,
  });
  return { status: response.status, body: await response.json() as any };
}

describe('NOC-303 release blockers and feedback contracts', () => {
  let db: Database;
  let server: Server;
  let teamId: string;
  let otherTeamId: string;
  let teamToken: string;
  let otherTeamToken: string;
  let teamlessToken: string;

  beforeEach(async () => {
    db = await createDatabase();
    teamId = uuidv4();
    otherTeamId = uuidv4();
    teamToken = createTestToken({ sub: 'noc303-team-user', org_id: teamId });
    otherTeamToken = createTestToken({ sub: 'noc303-other-user', org_id: otherTeamId });
    teamlessToken = createTestToken({ sub: 'noc303-teamless-user' });
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', ['noc303-team-user', 'noc303-team-user', 'primary', 'Primary']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', ['noc303-other-user', 'noc303-other-user', 'other', 'Other']);
    db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [teamId, 'Primary', 'primary', 'noc303-team-user']);
    db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [otherTeamId, 'Other', 'other', 'noc303-other-user']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [uuidv4(), teamId, 'noc303-team-user', 'owner']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [uuidv4(), otherTeamId, 'noc303-other-user', 'owner']);
    server = startApiServer(db, { port: 0 });
  });

  afterEach(() => {
    if (server.listening) server.close();
    if (db) db.close();
  });

  it('finding 1 upgrades a persisted database before creating ownership indexes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noc303-persisted-'));
    const dbPath = path.join(directory, 'persisted.db');
    try {
      const legacy = await createDatabase();
      legacy.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', ['legacy-team', 'Legacy', 'legacy', 'legacy-user']);
      legacy.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, ?)', [
        'legacy-channel', 'Legacy', 'slack', '{}', 'legacy-team',
      ]);
      saveDatabase(legacy, dbPath);
      legacy.close();

      const upgraded = await createDatabase(dbPath);
      try {
        const columns = upgraded.exec('PRAGMA table_info(alert_channels)');
        assert.ok(columns[0].values.some((row: any) => row[1] === 'owner_id'));
        const channel = upgraded.exec('SELECT id, team_id FROM alert_channels WHERE id = ?', ['legacy-channel']);
        assert.strictEqual(channel[0].values.length, 1);
      } finally {
        upgraded.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finding 2 records applied migrations and does not apply them twice', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noc303-ledger-'));
    const dbPath = path.join(directory, 'ledger.db');
    try {
      const first = await createDatabase(dbPath);
      const firstRows = first.exec('SELECT migration_id FROM schema_migrations ORDER BY migration_id');
      assert.ok(firstRows[0].values.length > 0);
      saveDatabase(first, dbPath);
      first.close();

      const second = await createDatabase(dbPath);
      try {
        const secondRows = second.exec('SELECT migration_id FROM schema_migrations ORDER BY migration_id');
        assert.deepStrictEqual(
          secondRows[0].values.map((row: any) => row[0]),
          firstRows[0].values.map((row: any) => row[0]),
        );
      } finally {
        second.close();
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finding 3 refuses a teamless caller from reading ownerless analytics rows', async () => {
    db.run('INSERT INTO analytics_events (id, dedup_key, team_id, user_id, event, schema_version, occurred_at, properties) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', [
      'legacy-event', 'personal:event:legacy-event', 'legacy-user', 'feedback_submitted', '1.0', new Date().toISOString(), '{}',
    ]);
    const result = await request(server, '/api/analytics/events', teamlessToken);
    assert.strictEqual(result.status, 403);
    assert.ok(!JSON.stringify(result.body).includes('legacy-event'));
  });

  it('finding 4 refuses a cross-user notification send', async () => {
    const channelId = uuidv4();
    db.run('INSERT INTO alert_channels (id, name, type, config, team_id, owner_id) VALUES (?, ?, ?, ?, ?, ?)', [
      channelId, 'Foreign', 'slack', '{}', otherTeamId, 'noc303-other-user',
    ]);
    const result = await request(server, '/api/notifications/send', teamToken, {
      method: 'POST',
      body: JSON.stringify({ channelId, title: 'Blocked', failureType: 'test', severity: 'info' }),
    });
    assert.strictEqual(result.status, 404);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM alert_log')[0].values[0][0]), 0);
  });

  it('finding 5 hides and refuses ownerless channels and applications', async () => {
    db.run('INSERT INTO alert_channels (id, name, type, config, team_id, owner_id) VALUES (?, ?, ?, ?, NULL, NULL)', [
      'ownerless-channel', 'Ownerless', 'slack', '{}',
    ]);
    const channels = await request(server, '/api/notifications/channels', teamlessToken);
    assert.strictEqual(channels.status, 403);
    assert.ok(!JSON.stringify(channels.body).includes('ownerless-channel'));

    const apps = await request(server, '/api/apps', teamlessToken);
    assert.strictEqual(apps.status, 403);
  });

  it('finding 6 refuses a teamless alerting-rule read', async () => {
    db.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, NULL)', [
      'ownerless-rule-channel', 'Ownerless', 'slack', '{}',
    ]);
    db.run('INSERT INTO alert_rules (id, name, channel_id, failure_types, team_id) VALUES (?, ?, ?, ?, NULL)', [
      'ownerless-rule', 'Ownerless', 'ownerless-rule-channel', '[]',
    ]);
    const result = await request(server, '/api/alerting/rules', teamlessToken);
    assert.strictEqual(result.status, 403);
    assert.ok(!JSON.stringify(result.body).includes('ownerless-rule'));
  });

  it('finding 7 rejects client-controlled private notification destinations', async () => {
    const cases = [
      { name: 'Webhook', type: 'slack-webhook', config: { webhookUrl: 'http://127.0.0.1:9/hook' } },
      { name: 'Socket', type: 'in-app-websocket', config: { url: 'http://169.254.169.254/latest/meta-data', reconnect: true } },
      { name: 'Mail', type: 'email-smtp', config: { smtpHost: '10.0.0.5', smtpPort: 25, smtpUser: 'u', smtpPass: 'p', fromAddress: 'sender', toAddresses: ['receiver'] } },
    ];
    for (const item of cases) {
      const result = await request(server, '/api/notifications/channels', teamToken, {
        method: 'POST',
        body: JSON.stringify(item),
      });
      assert.strictEqual(result.status, 400, item.name);
    }
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM alert_channels')[0].values[0][0]), 0);
  });

  it('finding 8 returns a generic non-2xx response when startup fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noc303-fallback-'));
    const dbPath = path.join(directory, 'invalid.db');
    fs.writeFileSync(dbPath, Buffer.from('invalid'));
    const probe = startApiServer(db, { port: 0 });
    const port = (probe.address() as any).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const child = spawn(process.execPath, ['-r', 'ts-node/register', 'src/index.ts'], {
      cwd: path.resolve(__dirname, '..', '..'),
      env: { ...process.env, DB_PATH: dbPath, PORT: String(port), NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let response: Response | null = null;
      for (let attempt = 0; attempt < 50 && !response; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          response = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/health`);
        } catch {
          response = null;
        }
      }
      assert.ok(response, 'the failed-start server must listen');
      const body = await response.json() as any;
      assert.strictEqual(response.status, 503);
      assert.deepStrictEqual(body, { status: 'unavailable' });
    } finally {
      child.kill();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finding 9 binds dedupMinutes instead of interpolating it into SQL', async () => {
    const { checkDedup, getDedupFingerprint, setDedupSuppression } = require('../notifications/service');
    const channelId = uuidv4();
    db.run('INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, ?)', [
      channelId, 'Bound', 'slack', '{}', teamId,
    ]);
    const payload = {
      title: 'Bound', description: '', failureType: 'test', severity: 'info', detectedAt: new Date().toISOString(),
    };
    const fingerprint = getDedupFingerprint(payload);
    checkDedup(db, channelId, fingerprint);
    assert.doesNotThrow(() => setDedupSuppression(db, channelId, fingerprint, '5; DELETE FROM notification_deduplication; --' as any));
    const rows = db.exec('SELECT suppress_until FROM notification_deduplication WHERE channel_id = ? AND fingerprint = ?', [channelId, fingerprint]);
    assert.strictEqual(rows[0].values.length, 1);
    assert.ok(rows[0].values[0][0]);
  });

  it('finding 10 resolves a public target with an injected resolver and no network', async () => {
    const { resolvePublicTarget } = require('../engine/outbound-safety');
    const resolved = await resolvePublicTarget('public.example', async () => ['93.184.216.34']);
    assert.deepStrictEqual(resolved.addresses, ['93.184.216.34']);
  });

  it('finding 11 conflicts when a response id is reused with a changed payload', async () => {
    const responseId = uuidv4();
    const first = await request(server, '/api/feedback/responses', teamToken, {
      method: 'POST',
      body: JSON.stringify({ response_id: responseId, kind: 'feedback', feedback_type: 'general', response: {} }),
    });
    assert.strictEqual(first.status, 200);

    const changed = await request(server, '/api/feedback/responses', teamToken, {
      method: 'POST',
      body: JSON.stringify({ response_id: responseId, kind: 'feedback', feedback_type: 'bug_report', response: {} }),
    });
    assert.strictEqual(changed.status, 409);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM feedback_responses WHERE id = ?', [responseId])[0].values[0][0]), 1);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [responseId])[0].values[0][0]), 1);
  });

  it('finding 12 rolls back a failed event write and repairs one response and one event on retry', async () => {
    const responseId = uuidv4();
    const originalRun = db.run.bind(db);
    let injected = false;
    db.run = ((sql: string, ...params: any[]) => {
      if (!injected && sql.includes('INSERT INTO analytics_events')) {
        injected = true;
        throw new Error('injected event write failure');
      }
      return originalRun(sql, ...params);
    }) as any;

    const failed = await request(server, '/api/feedback/responses', teamToken, {
      method: 'POST',
      body: JSON.stringify({ response_id: responseId, kind: 'feedback', feedback_type: 'general', response: {} }),
    });
    db.run = originalRun;
    assert.strictEqual(failed.status, 500);
    assert.notStrictEqual(failed.body.success, true);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM feedback_responses WHERE id = ?', [responseId])[0].values[0][0]), 0);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [responseId])[0].values[0][0]), 0);

    const repaired = await request(server, '/api/feedback/responses', teamToken, {
      method: 'POST',
      body: JSON.stringify({ response_id: responseId, kind: 'feedback', feedback_type: 'general', response: {} }),
    });
    assert.strictEqual(repaired.status, 200);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM feedback_responses WHERE id = ?', [responseId])[0].values[0][0]), 1);
    assert.strictEqual(Number(db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [responseId])[0].values[0][0]), 1);
  });
});
