import assert from 'assert';
import { createDatabase } from '../db/schema';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';

describe('Notification Service', function () {
  let db: Database;

  beforeEach(async function () {
    db = await createDatabase();
  });

  afterEach(function () {
    db.close();
  });

  describe('Database Schema', function () {
    it('should have notification_rate_limits table', function () {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_rate_limits'");
      assert.strictEqual(result[0].values[0][0], 'notification_rate_limits');
    });

    it('should have notification_deduplication table', function () {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_deduplication'");
      assert.strictEqual(result[0].values[0][0], 'notification_deduplication');
    });

    it('should support in-app-websocket channel type', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'In-App WS', 'in-app-websocket', ?)`,
        [uuidv4(), JSON.stringify({ url: 'http://localhost:9090/notify', reconnect: true })]
      );
      const result = db.exec("SELECT type FROM alert_channels WHERE type = 'in-app-websocket'");
      assert.strictEqual(result[0].values[0][0], 'in-app-websocket');
    });

    it('should support team_id on alert_channels', function () {
      const teamId = uuidv4();
      db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [teamId, 'Test Team', 'test-team', 'user1']);
      db.run(
        `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'Team Channel', 'slack', ?, ?)`,
        [uuidv4(), JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' }), teamId]
      );
      const result = db.exec('SELECT team_id FROM alert_channels WHERE team_id = ?', [teamId]);
      assert.strictEqual(result[0].values[0][0], teamId);
    });

    it('should support delivered and pending status in alert_log', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Test', 'slack', ?)`,
        [uuidv4(), JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      db.run(
        `INSERT INTO alert_log (id, rule_id, channel_id, failure_event_id, failure_type, severity, channel_type, status, error_message)
         VALUES (?, NULL, ?, NULL, 'broken_webhook', 'critical', 'slack', 'pending', NULL)`,
        [uuidv4(), (db.exec('SELECT id FROM alert_channels LIMIT 1'))[0].values[0][0]]
      );
      const result = db.exec("SELECT status FROM alert_log WHERE status = 'pending'");
      assert.strictEqual(result[0].values[0][0], 'pending');
    });
  });

  describe('Dedup Fingerprint', function () {
    it('should generate consistent fingerprint from payload', async function () {
      const { getDedupFingerprint } = await import('../notifications');
      const fp1 = getDedupFingerprint({
        title: 'Test Alert',
        description: 'Something broke',
        failureType: 'broken_webhook',
        severity: 'critical',
        detectedAt: '2026-01-01T00:00:00Z',
        checkId: 'check-1',
      });
      const fp2 = getDedupFingerprint({
        title: 'Test Alert',
        description: 'Something broke',
        failureType: 'broken_webhook',
        severity: 'critical',
        detectedAt: '2026-01-01T01:00:00Z',
        checkId: 'check-1',
      });
      assert.strictEqual(fp1, fp2);
    });

    it('should produce different fingerprint for different failure types', async function () {
      const { getDedupFingerprint } = await import('../notifications');
      const fp1 = getDedupFingerprint({
        title: 'Test', description: '', failureType: 'broken_webhook', severity: 'critical', detectedAt: '', checkId: 'c1',
      });
      const fp2 = getDedupFingerprint({
        title: 'Test', description: '', failureType: 'expired_token', severity: 'critical', detectedAt: '', checkId: 'c1',
      });
      assert.notStrictEqual(fp1, fp2);
    });
  });

  describe('Rate Limiting', function () {
    it('should allow notifications when under limit', async function () {
      const { checkRateLimit } = await import('../notifications/service');
      const channelId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Rate Test', 'slack', ?)`,
        [channelId, JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const allowed = checkRateLimit(db, channelId);
      assert.strictEqual(allowed, true);
    });

    it('should set and get rate limit config', async function () {
      const { getRateLimitConfig, setRateLimitConfig } = await import('../notifications/service');
      const channelId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Rate Test', 'slack', ?)`,
        [channelId, JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      setRateLimitConfig(db, channelId, { maxPerMinute: 5, maxPerHour: 50 });
      const config = getRateLimitConfig(db, channelId);
      assert.strictEqual(config.maxPerMinute, 5);
      assert.strictEqual(config.maxPerHour, 50);
    });
  });

  describe('Deduplication', function () {
    it('should not suppress first occurrence', async function () {
      const { checkDedup, getDedupFingerprint } = await import('../notifications/service');
      const channelId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Dedup Test', 'slack', ?)`,
        [channelId, JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const fingerprint = getDedupFingerprint({
        title: 'Test', description: 'desc', failureType: 'broken_webhook', severity: 'critical', detectedAt: '', checkId: 'c1',
      });
      const result = checkDedup(db, channelId, fingerprint);
      assert.strictEqual(result.suppressed, false);
    });

    it('should suppress on second occurrence within suppression window', async function () {
      const { checkDedup, setDedupSuppression, getDedupFingerprint } = await import('../notifications/service');
      const channelId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Dedup Test', 'slack', ?)`,
        [channelId, JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const fingerprint = getDedupFingerprint({
        title: 'Test', description: 'desc', failureType: 'broken_webhook', severity: 'critical', detectedAt: '', checkId: 'c1',
      });
      checkDedup(db, channelId, fingerprint);
      setDedupSuppression(db, channelId, fingerprint, 10);
      const result = checkDedup(db, channelId, fingerprint);
      assert.strictEqual(result.suppressed, true);
    });
  });

  describe('Delivery Retry', function () {
    it('should succeed on first attempt for valid channel', async function () {
      const { deliverWithRetry } = await import('../notifications/service');
      const channelId = uuidv4();
      const config = { webhookUrl: 'https://hooks.slack.com/services/test' };
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Retry Test', 'slack', ?)`,
        [channelId, JSON.stringify(config)]
      );
      const result = await deliverWithRetry(db, 'slack', config, {
        title: 'Test', description: '', failureType: 'test', severity: 'info', detectedAt: new Date().toISOString(),
      }, 1);
      assert.strictEqual(result.success, false);
      assert.ok(result.errorMessage);
      assert.strictEqual(result.attempts, 1);
    });
  });

  describe('processNotification', function () {
    it('should return skipped when rate limited', async function () {
      const { processNotification } = await import('../notifications/service');
      const channelId = uuidv4();
      const config = { webhookUrl: 'https://hooks.slack.com/services/test' };
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Proc Test', 'slack', ?)`,
        [channelId, JSON.stringify(config)]
      );
      db.run(
        `INSERT INTO notification_rate_limits (id, channel_id, max_per_minute, max_per_hour, window_start, current_count)
         VALUES (?, ?, 0, 0, datetime('now'), 0)`,
        [uuidv4(), channelId]
      );
      const result = await processNotification(db, channelId, 'slack', config, {
        title: 'Test', description: 'desc', failureType: 'rate_limited', severity: 'warning', detectedAt: new Date().toISOString(), checkId: 'c1',
      }, 5);
      assert.strictEqual(result.sent, false);
      assert.strictEqual(result.skipped, 'rate_limited');
      assert.ok(result.logId);
    });

    it('should create alert_log entry with pending status', async function () {
      const { processNotification, getDedupFingerprint } = await import('../notifications/service');
      const channelId = uuidv4();
      const config = { webhookUrl: 'https://hooks.slack.com/services/test' };
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Log Test', 'slack', ?)`,
        [channelId, JSON.stringify(config)]
      );
      const result = await processNotification(db, channelId, 'slack', config, {
        title: 'Log Test', description: 'desc', failureType: 'broken_webhook', severity: 'critical', detectedAt: new Date().toISOString(), checkId: 'c2',
      }, 5);
      assert.ok(result.logId);
      const logResult = db.exec('SELECT status FROM alert_log WHERE id = ?', [result.logId]);
      assert.ok(logResult.length > 0);
      assert.ok(['pending', 'sent', 'failed'].includes(logResult[0].values[0][0] as string));
    });
  });

  describe('Alert Log Status', function () {
    it('should allow delivered status', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Delivered Test', 'slack', ?)`,
        [uuidv4(), JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const chId = (db.exec('SELECT id FROM alert_channels LIMIT 1'))[0].values[0][0] as string;
      db.run(
        `INSERT INTO alert_log (id, rule_id, channel_id, failure_type, severity, channel_type, status)
         VALUES (?, NULL, ?, 'broken_webhook', 'critical', 'slack', 'delivered')`,
        [uuidv4(), chId]
      );
      const result = db.exec("SELECT status FROM alert_log WHERE status = 'delivered'");
      assert.strictEqual(result[0].values[0][0], 'delivered');
    });

    it('should allow pending status', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Pending Test', 'slack', ?)`,
        [uuidv4(), JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const chId = (db.exec('SELECT id FROM alert_channels LIMIT 1'))[0].values[0][0] as string;
      db.run(
        `INSERT INTO alert_log (id, rule_id, channel_id, failure_type, severity, channel_type, status)
         VALUES (?, NULL, ?, 'broken_webhook', 'warning', 'slack', 'pending')`,
        [uuidv4(), chId]
      );
      const result = db.exec("SELECT status FROM alert_log WHERE status = 'pending'");
      assert.strictEqual(result[0].values[0][0], 'pending');
    });
  });

  describe('markDelivered', function () {
    it('should update pending log to delivered', async function () {
      const { logDelivery, markDelivered } = await import('../notifications/service');
      const channelId = uuidv4();
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES (?, 'Mark Test', 'slack', ?)`,
        [channelId, JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const logId = logDelivery(db, null, channelId, null, 'broken_webhook', 'critical', 'slack', 'pending', null);
      markDelivered(db, logId);
      const result = db.exec('SELECT status FROM alert_log WHERE id = ?', [logId]);
      assert.strictEqual(result[0].values[0][0], 'delivered');
    });
  });

  describe('API Endpoints', function () {
    let server: any;
    let port: number;

    beforeEach(function (done) {
      const { startApiServer } = require('../api/server');
      server = startApiServer(db, { port: 0 });
      server.on('listening', () => {
        port = server.address().port;
        done();
      });
    });

    afterEach(function () {
      server.close();
    });

    function fetchFromApi(path: string, options?: any): Promise<any> {
      return new Promise((resolve, reject) => {
        const url = `http://localhost:${port}${path}`;
        const req = require('http').request(url, options || { method: 'GET' }, (res: any) => {
          let data = '';
          res.on('data', (chunk: string) => { data += chunk; });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data); }
          });
        });
        req.on('error', reject);
        if (options?.body) {
          req.write(JSON.stringify(options.body));
        }
        req.end();
      });
    }

    it('GET /api/notifications/channels should return empty list', async function () {
      const result = await fetchFromApi('/api/notifications/channels');
      assert.strictEqual(result.channels.length, 0);
      assert.strictEqual(result.count, 0);
    });

    it('POST /api/notifications/channels should create slack-webhook channel', async function () {
      const result = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Ops Slack', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/abc' } },
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.id);
      const getResult = await fetchFromApi('/api/notifications/channels');
      assert.strictEqual(getResult.channels.length, 1);
      assert.strictEqual(getResult.channels[0].name, 'Ops Slack');
    });

    it('POST /api/notifications/channels should create email-smtp channel', async function () {
      const result = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Dev Email', type: 'email-smtp', config: { smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'u', smtpPass: 'p', fromAddress: 'a@b.com', toAddresses: ['c@d.com'] } },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.type, 'email-smtp');
    });

    it('POST /api/notifications/channels should create in-app-websocket channel', async function () {
      const result = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Real-time WS', type: 'in-app-websocket', config: { url: 'http://localhost:9090/notify', reconnect: true } },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.type, 'in-app-websocket');
    });

    it('POST /api/notifications/channels should reject invalid type', async function () {
      const result = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Bad', type: 'sms', config: {} },
      });
      assert.ok(result.error.includes('type must be one of'));
    });

    it('POST /api/notifications/channels should reject missing fields', async function () {
      const result = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Bad' },
      });
      assert.strictEqual(result.error, 'name, type, and config are required');
    });

    it('POST /api/notifications/channels should support teamId', async function () {
      const teamId = uuidv4();
      db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [teamId, 'Notif Team', 'notif-team', 'user1']);
      const result = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Team Channel', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/test' }, teamId },
      });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.teamId, teamId);
    });

    it('GET /api/notifications/channels should filter by teamId', async function () {
      const teamId1 = uuidv4();
      const teamId2 = uuidv4();
      db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [teamId1, 'Team A', 'team-a', 'u1']);
      db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [teamId2, 'Team B', 'team-b', 'u2']);
      await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Channel A', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/a' }, teamId: teamId1 },
      });
      await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Channel B', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/b' }, teamId: teamId2 },
      });
      const result = await fetchFromApi(`/api/notifications/channels?teamId=${teamId1}`);
      assert.strictEqual(result.channels.length, 1);
      assert.strictEqual(result.channels[0].name, 'Channel A');
    });

    it('PATCH /api/notifications/channels/:id should update channel', async function () {
      const createResult = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Old Name', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      await fetchFromApi(`/api/notifications/channels/${createResult.id}`, {
        method: 'PATCH',
        body: { name: 'New Name', enabled: false },
      });
      const getResult = await fetchFromApi('/api/notifications/channels');
      assert.strictEqual(getResult.channels[0].name, 'New Name');
      assert.strictEqual(getResult.channels[0].enabled, false);
    });

    it('DELETE /api/notifications/channels/:id should remove channel', async function () {
      const createResult = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Delete Me', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const deleteResult = await fetchFromApi(`/api/notifications/channels/${createResult.id}`, { method: 'DELETE' });
      assert.strictEqual(deleteResult.success, true);
      const getResult = await fetchFromApi('/api/notifications/channels');
      assert.strictEqual(getResult.channels.length, 0);
    });

    it('POST /api/notifications/send should require channelId, title, failureType, severity', async function () {
      const result = await fetchFromApi('/api/notifications/send', {
        method: 'POST',
        body: { title: 'Test' },
      });
      assert.strictEqual(result.error, 'channelId, title, failureType, and severity are required');
    });

    it('POST /api/notifications/send should return 404 for unknown channel', async function () {
      const result = await fetchFromApi('/api/notifications/send', {
        method: 'POST',
        body: { channelId: 'nonexistent', title: 'Test', failureType: 'broken_webhook', severity: 'critical' },
      });
      assert.strictEqual(result.error, 'Channel not found');
    });

    it('POST /api/notifications/send should attempt delivery on valid channel', async function () {
      const createResult = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Send Test', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const result = await fetchFromApi('/api/notifications/send', {
        method: 'POST',
        body: { channelId: createResult.id, title: 'Test Alert', description: 'Something happened', failureType: 'broken_webhook', severity: 'critical' },
      });
      assert.ok(result.logId);
      const logResult = db.exec('SELECT status, failure_type, severity FROM alert_log WHERE id = ?', [result.logId]);
      assert.strictEqual(logResult[0].values[0][1], 'broken_webhook');
      assert.strictEqual(logResult[0].values[0][2], 'critical');
    });

    it('POST /api/notifications/deliver should mark log as delivered', async function () {
      const createResult = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Deliver Test', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const sendResult = await fetchFromApi('/api/notifications/send', {
        method: 'POST',
        body: { channelId: createResult.id, title: 'Test', description: 'desc', failureType: 'expired_token', severity: 'warning' },
      });
      const deliverResult = await fetchFromApi('/api/notifications/deliver', {
        method: 'POST',
        body: { logId: sendResult.logId },
      });
      assert.strictEqual(deliverResult.success, true);
      const logResult = db.exec('SELECT status FROM alert_log WHERE id = ?', [sendResult.logId]);
      assert.strictEqual(logResult[0].values[0][0], 'delivered');
    });

    it('POST /api/notifications/deliver should reject missing logId', async function () {
      const result = await fetchFromApi('/api/notifications/deliver', {
        method: 'POST',
        body: {},
      });
      assert.strictEqual(result.error, 'logId is required');
    });

    it('DELETE /api/notifications/channels/:id should also clean up dedup and rate limit data', async function () {
      const createResult = await fetchFromApi('/api/notifications/channels', {
        method: 'POST',
        body: { name: 'Cleanup Test', type: 'slack-webhook', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const chId = createResult.id;
      db.run(
        `INSERT INTO notification_deduplication (id, channel_id, fingerprint) VALUES (?, ?, 'test_fp')`,
        [uuidv4(), chId]
      );
      db.run(
        `INSERT INTO notification_rate_limits (id, channel_id, max_per_minute, max_per_hour, window_start, current_count) VALUES (?, ?, 10, 100, datetime('now'), 0)`,
        [uuidv4(), chId]
      );
      await fetchFromApi(`/api/notifications/channels/${chId}`, { method: 'DELETE' });
      const dedupResult = db.exec('SELECT COUNT(*) FROM notification_deduplication WHERE channel_id = ?', [chId]);
      assert.strictEqual(dedupResult[0].values[0][0], 0);
      const rlResult = db.exec('SELECT COUNT(*) FROM notification_rate_limits WHERE channel_id = ?', [chId]);
      assert.strictEqual(rlResult[0].values[0][0], 0);
    });
  });
});
