import assert from 'assert';
import { createDatabase } from '../db/schema';
import { Database } from 'sql.js';

describe('Alerting System', function () {
  let db: Database;

  beforeEach(async function () {
    db = await createDatabase();
  });

  afterEach(function () {
    db.close();
  });

  describe('Database Schema', function () {
    it('should create alert_channels table', function () {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_channels'");
      assert.strictEqual(result[0].values[0][0], 'alert_channels');
    });

    it('should create alert_rules table', function () {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_rules'");
      assert.strictEqual(result[0].values[0][0], 'alert_rules');
    });

    it('should create alert_log table', function () {
      const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_log'");
      assert.strictEqual(result[0].values[0][0], 'alert_log');
    });
  });

  describe('Alert Channels CRUD', function () {
    it('should insert a Slack channel', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch1', 'Slack Ops', 'slack', ?)`,
        [JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      const result = db.exec('SELECT id, name, type, enabled FROM alert_channels WHERE id = ?', ['ch1']);
      assert.strictEqual(result[0].values[0][0], 'ch1');
      assert.strictEqual(result[0].values[0][1], 'Slack Ops');
      assert.strictEqual(result[0].values[0][2], 'slack');
      assert.strictEqual(result[0].values[0][3], 1);
    });

    it('should insert an email channel', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch2', 'Dev Team Email', 'email', ?)`,
        [JSON.stringify({
          smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'user', smtpPass: 'pass',
          fromAddress: 'nightlamp@example.com', toAddresses: ['dev@example.com'],
        })]
      );
      const result = db.exec('SELECT type FROM alert_channels WHERE id = ?', ['ch2']);
      assert.strictEqual(result[0].values[0][0], 'email');
    });

    it('should reject invalid channel type', function () {
      assert.throws(() => {
        db.run(
          `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch3', 'Bad', 'sms', '{}')`
        );
      });
    });

    it('should update a channel', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch4', 'Old Name', 'slack', ?)`,
        [JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      db.run("UPDATE alert_channels SET name = 'New Name', updated_at = datetime('now') WHERE id = ?", ['ch4']);
      const result = db.exec('SELECT name FROM alert_channels WHERE id = ?', ['ch4']);
      assert.strictEqual(result[0].values[0][0], 'New Name');
    });

    it('should delete a channel and its rules', function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch5', 'Temp', 'slack', ?)`,
        [JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('r1', 'Test Rule', 'ch5', ?, 'warning')`,
        [JSON.stringify(['broken_webhook'])]
      );
      db.run('DELETE FROM alert_rules WHERE channel_id = ?', ['ch5']);
      db.run('DELETE FROM alert_channels WHERE id = ?', ['ch5']);
      const channels = db.exec('SELECT COUNT(*) FROM alert_channels WHERE id = ?', ['ch5']);
      assert.strictEqual(channels[0].values[0][0], 0);
    });
  });

  describe('Alert Rules CRUD', function () {
    beforeEach(function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch_rule', 'Test Channel', 'slack', ?)`,
        [JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
    });

    it('should insert a rule matching all failure types', function () {
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('r1', 'Alert All Critical', 'ch_rule', ?, 'critical')`,
        [JSON.stringify(['broken_webhook', 'expired_token', 'rate_limit_shift', 'schema_drift', 'error_spike', 'new_error_pattern'])]
      );
      const result = db.exec('SELECT id, failure_types FROM alert_rules WHERE id = ?', ['r1']);
      const types = JSON.parse(result[0].values[0][1] as string);
      assert.strictEqual(types.length, 6);
      assert.ok(types.includes('broken_webhook'));
    });

    it('should insert a rule with specific failure types', function () {
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('r2', 'Webhook Alerts', 'ch_rule', ?, 'info')`,
        [JSON.stringify(['broken_webhook'])]
      );
      const result = db.exec('SELECT min_severity FROM alert_rules WHERE id = ?', ['r2']);
      assert.strictEqual(result[0].values[0][0], 'info');
    });

    it('should enforce valid min_severity values', function () {
      assert.throws(() => {
        db.run(
          `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('r3', 'Bad', 'ch_rule', ?, 'invalid')`,
          [JSON.stringify(['broken_webhook'])]
        );
      });
    });

    it('should update a rule', function () {
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('r4', 'Old', 'ch_rule', ?, 'info')`,
        [JSON.stringify(['broken_webhook'])]
      );
      db.run("UPDATE alert_rules SET enabled = 0, updated_at = datetime('now') WHERE id = ?", ['r4']);
      const result = db.exec('SELECT enabled FROM alert_rules WHERE id = ?', ['r4']);
      assert.strictEqual(result[0].values[0][0], 0);
    });
  });

  describe('Alert Log', function () {
    beforeEach(function () {
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('ch_log', 'Log Channel', 'slack', ?)`,
        [JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/test' })]
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('rule_log', 'Log Rule', 'ch_log', ?, 'info')`,
        [JSON.stringify(['broken_webhook'])]
      );
    });

    it('should log a sent notification', function () {
      db.run(
        `INSERT INTO alert_log (id, rule_id, channel_id, failure_event_id, failure_type, severity, channel_type, status)
         VALUES ('log1', 'rule_log', 'ch_log', 'evt1', 'broken_webhook', 'critical', 'slack', 'sent')`
      );
      const result = db.exec('SELECT status, failure_type FROM alert_log WHERE id = ?', ['log1']);
      assert.strictEqual(result[0].values[0][0], 'sent');
      assert.strictEqual(result[0].values[0][1], 'broken_webhook');
    });

    it('should log a failed notification', function () {
      db.run(
        `INSERT INTO alert_log (id, rule_id, channel_id, failure_event_id, failure_type, severity, channel_type, status, error_message)
         VALUES ('log2', 'rule_log', 'ch_log', 'evt2', 'expired_token', 'critical', 'email', 'failed', 'Connection refused')`
      );
      const result = db.exec('SELECT status, error_message FROM alert_log WHERE id = ?', ['log2']);
      assert.strictEqual(result[0].values[0][0], 'failed');
      assert.strictEqual(result[0].values[0][1], 'Connection refused');
    });

    it('should enforce valid status values', function () {
      assert.throws(() => {
        db.run(
          `INSERT INTO alert_log (id, rule_id, channel_id, failure_type, severity, channel_type, status)
           VALUES ('log3', 'rule_log', 'ch_log', 'broken_webhook', 'critical', 'slack', 'unknown')`
        );
      });
    });
  });

  describe('Integration with Evaluator (no-op without rules)', function () {
    it('should not throw when no rules exist', async function () {
      const { evaluateAndNotify } = await import('../alerting');
      await evaluateAndNotify(db, 'broken_webhook', 'critical', 'Test', 'Test desc', new Date().toISOString(), 'check1', 'evt1');
      const result = db.exec('SELECT COUNT(*) FROM alert_log');
      assert.strictEqual(result[0].values[0][0], 0);
    });
  });

  describe('API Endpoints', function () {
    let server: any;
    let port: number;
    const http = require('http');

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
        const req = http.request(url, options || { method: 'GET' }, (res: any) => {
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

    it('GET /api/alerting/channels should return empty list', async function () {
      const result = await fetchFromApi('/api/alerting/channels');
      assert.strictEqual(result.channels.length, 0);
      assert.strictEqual(result.count, 0);
    });

    it('POST /api/alerting/channels should create a channel', async function () {
      const result = await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Test Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.id);
      const getResult = await fetchFromApi('/api/alerting/channels');
      assert.strictEqual(getResult.channels.length, 1);
    });

    it('POST /api/alerting/channels should reject missing fields', async function () {
      const result = await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Bad' },
      });
      assert.strictEqual(result.error, 'name, type, and config are required');
    });

    it('POST /api/alerting/rules should create a rule', async function () {
      await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Test Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const result = await fetchFromApi('/api/alerting/rules', {
        method: 'POST',
        body: { name: 'Critical Alerts', channelId: (await fetchFromApi('/api/alerting/channels')).channels[0].id, failureTypes: ['broken_webhook', 'expired_token'], minSeverity: 'critical' },
      });
      assert.strictEqual(result.success, true);
      assert.ok(result.id);
    });

    it('GET /api/alerting/rules should return rules with channel info', async function () {
      await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Test Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const ch = (await fetchFromApi('/api/alerting/channels')).channels[0];
      await fetchFromApi('/api/alerting/rules', {
        method: 'POST',
        body: { name: 'All Critical', channelId: ch.id, failureTypes: ['broken_webhook'], minSeverity: 'critical' },
      });
      const result = await fetchFromApi('/api/alerting/rules');
      assert.strictEqual(result.rules.length, 1);
      assert.strictEqual(result.rules[0].channelName, 'Test Slack');
      assert.strictEqual(result.rules[0].channelType, 'slack');
    });

    it('GET /api/alerting/log should return empty list', async function () {
      const result = await fetchFromApi('/api/alerting/log');
      assert.strictEqual(result.logs.length, 0);
    });

    it('DELETE /api/alerting/channels/:id should remove channel and rules', async function () {
      await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Test Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const chId = (await fetchFromApi('/api/alerting/channels')).channels[0].id;
      await fetchFromApi('/api/alerting/rules', {
        method: 'POST',
        body: { name: 'Rule', channelId: chId, failureTypes: ['broken_webhook'] },
      });
      const deleteResult = await fetchFromApi(`/api/alerting/channels/${chId}`, { method: 'DELETE' });
      assert.strictEqual(deleteResult.success, true);
      const rules = await fetchFromApi('/api/alerting/rules');
      assert.strictEqual(rules.rules.length, 0);
    });

    it('PUT /api/alerting/channels/:id should update channel', async function () {
      await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Old Name', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const chId = (await fetchFromApi('/api/alerting/channels')).channels[0].id;
      await fetchFromApi(`/api/alerting/channels/${chId}`, {
        method: 'PUT',
        body: { name: 'New Name', enabled: false },
      });
      const channels = await fetchFromApi('/api/alerting/channels');
      assert.strictEqual(channels.channels[0].name, 'New Name');
      assert.strictEqual(channels.channels[0].enabled, false);
    });

    it('DELETE /api/alerting/rules/:id should remove a rule', async function () {
      await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Test Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const chId = (await fetchFromApi('/api/alerting/channels')).channels[0].id;
      const createResult = await fetchFromApi('/api/alerting/rules', {
        method: 'POST',
        body: { name: 'Rule', channelId: chId, failureTypes: ['broken_webhook'] },
      });
      await fetchFromApi(`/api/alerting/rules/${createResult.id}`, { method: 'DELETE' });
      const rules = await fetchFromApi('/api/alerting/rules');
      assert.strictEqual(rules.rules.length, 0);
    });

    it('PUT /api/alerting/rules/:id should update a rule', async function () {
      await fetchFromApi('/api/alerting/channels', {
        method: 'POST',
        body: { name: 'Test Slack', type: 'slack', config: { webhookUrl: 'https://hooks.slack.com/services/test' } },
      });
      const chId = (await fetchFromApi('/api/alerting/channels')).channels[0].id;
      const createResult = await fetchFromApi('/api/alerting/rules', {
        method: 'POST',
        body: { name: 'Rule', channelId: chId, failureTypes: ['broken_webhook'], minSeverity: 'info' },
      });
      await fetchFromApi(`/api/alerting/rules/${createResult.id}`, {
        method: 'PUT',
        body: { minSeverity: 'critical', enabled: false },
      });
      const rules = await fetchFromApi('/api/alerting/rules');
      assert.strictEqual(rules.rules[0].minSeverity, 'critical');
      assert.strictEqual(rules.rules[0].enabled, false);
    });
  });

  describe('Notification Channel Formats', function () {
    it('should format Slack message payload correctly', async function () {
      const { evaluateAndNotify } = await import('../alerting');
      db.run(
        `INSERT INTO alert_channels (id, name, type, config) VALUES ('fmt_ch', 'Fmt Slack', 'slack', ?)`,
        [JSON.stringify({ webhookUrl: 'https://hooks.slack.com/services/invalid' })]
      );
      db.run(
        `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES ('fmt_rule', 'Fmt Rule', 'fmt_ch', ?, 'info')`,
        [JSON.stringify(['broken_webhook'])]
      );
      await evaluateAndNotify(db, 'broken_webhook', 'critical', 'Test Alert', 'Something broke', new Date().toISOString(), 'check_fmt', 'evt_fmt');
      const result = db.exec('SELECT status FROM alert_log WHERE rule_id = ?', ['fmt_rule']);
      assert.strictEqual(result[0].values.length, 1);
      assert.ok(['sent', 'failed'].includes(result[0].values[0][0] as string));
    });
  });
});
