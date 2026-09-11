import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { ReportsApi } from '../reports';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';

describe('Reports API', () => {
  let db: Database;
  let server: Server;
  let port: number;
  const checkId = 'c-report-1';
  const monitorId = 'c-mon-1';

  before(async () => {
    db = await createDatabase();

    db.run('INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)',
      [monitorId, 'uptimerobot', 'Test Monitor', JSON.stringify({ apiKey: 'test' }), 1]);
    db.run('INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)',
      [checkId, 'sentry', 'Test Sentry', JSON.stringify({ authToken: 'test', orgSlug: 'test', projectSlug: 'test' }), 1]);

    const now = new Date();
    for (let day = 0; day < 10; day++) {
      const d = new Date(now.getTime() - day * 86400000);
      const iso = d.toISOString();

      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), checkId, 'expired_token', 'critical', 'Token expired', 'desc', iso]
      );

      if (day % 3 === 0) {
        db.run(
          `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [uuidv4(), checkId, 'rate_limit_shift', 'warning', 'Rate limited', 'desc', iso]
        );
      }

      const status = day % 2 === 0 ? 'pass' : 'fail';
      db.run(
        `INSERT INTO check_results (id, check_id, status, summary, executed_at) VALUES (?, ?, ?, ?, ?)`,
        [uuidv4(), monitorId, status, `Check result day ${day}`, iso]
      );
    }

    const peId = uuidv4();
    db.run(
      `INSERT INTO playbook_entries (id, failure_type, title, body, first_seen_at, last_occurrence_at, occurrence_count) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [peId, 'expired_token', 'Expired Token', 'body', new Date().toISOString(), new Date().toISOString(), 5]
    );

    for (let i = 0; i < 3; i++) {
      db.run(
        'INSERT INTO remediation_log (id, playbook_entry_id, failure_type, script, status, output, executed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), peId, 'expired_token', 'rotate-token', i < 2 ? 'success' : 'failed', `Output ${i}`, new Date().toISOString()]
      );
    }
    const teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)',
      [teamId, 'Test Team', 'test-team', 'user-1']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, 'user-1', 'owner']);

    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  describe('ReportsApi class (unit)', () => {
    it('should create instance', () => {
      const api = new ReportsApi(db);
      assert.ok(api);
    });

    it('clearCache should not throw', () => {
      const api = new ReportsApi(db);
      api.clearCache();
      assert.ok(true);
    });
  });

  describe('GET /api/reports/incident-trends', () => {
    it('returns time-series incident data with default period', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/incident-trends`)).json() as any;
      assert.ok(res.period);
      assert.ok(res.granularity);
      assert.ok(Array.isArray(res.series));
      assert.ok(res.series.length > 0);
      assert.ok(res.series[0].period);
      assert.ok(typeof res.series[0].total === 'number');
      assert.ok(res.total > 0);
    });

    it('accepts period parameter (7d)', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/incident-trends?period=7d`)).json() as any;
      assert.strictEqual(res.period, '7d');
    });

    it('accepts period parameter (90d)', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/incident-trends?period=90d`)).json() as any;
      assert.strictEqual(res.period, '90d');
    });

    it('includes failure type breakdown in series', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/incident-trends`)).json() as any;
      assert.ok(Array.isArray(res.types));
      assert.ok(res.types.includes('expired_token'));
    });

    it('returns comparison when multiple periods available', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/incident-trends`)).json() as any;
      if (res.series.length >= 2) {
        assert.ok(res.comparison);
        assert.ok(res.comparison.type);
        assert.ok(typeof res.comparison.changePercent === 'number');
      }
    });
  });

  describe('GET /api/reports/uptime-stats', () => {
    it('returns aggregate for all monitors when no monitor_id', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/uptime-stats`)).json() as any;
      assert.ok(Array.isArray(res.monitors));
      assert.strictEqual(res.monitorId, null);
    });

    it('returns specific monitor stats with daily series', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/uptime-stats?monitor_id=${monitorId}`)).json() as any;
      assert.strictEqual(res.monitorId, monitorId);
      assert.ok(res.monitorName);
      assert.ok(res.summary);
      assert.ok(typeof res.summary.uptime === 'number');
      assert.ok(res.summary.totalChecks > 0);
      assert.ok(Array.isArray(res.dailySeries));
    });

    it('returns 404 for unknown monitor_id', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/reports/uptime-stats?monitor_id=nonexistent`);
      assert.strictEqual(res.status, 404);
    });
  });

  describe('GET /api/reports/playbook-effectiveness', () => {
    it('returns all entries when no playbook_id', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/playbook-effectiveness`)).json() as any;
      assert.strictEqual(res.playbookId, null);
      assert.ok(Array.isArray(res.entries));
      assert.ok(res.entries.length > 0);
    });

    it('returns detailed stats for a specific playbook', async () => {
      const allRes = await (await fetch(`http://127.0.0.1:${port}/api/reports/playbook-effectiveness`)).json() as any;
      const playbookId = allRes.entries[0].id;

      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/playbook-effectiveness?playbook_id=${playbookId}`)).json() as any;
      assert.strictEqual(res.playbookId, playbookId);
      assert.ok(res.entry);
      assert.ok(res.remediationStats);
      assert.ok(typeof res.remediationStats.successRate === 'number');
      assert.ok(Array.isArray(res.remediationHistory));
    });

    it('returns 404 for unknown playbook_id', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/reports/playbook-effectiveness?playbook_id=nonexistent`);
      assert.strictEqual(res.status, 404);
    });
  });

  describe('GET /api/reports/team-summary', () => {
    it('returns aggregated team metrics', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/team-summary`)).json() as any;
      assert.ok(res.teams);
      assert.ok(typeof res.teams.total === 'number');
      assert.ok(res.monitoring);
      assert.ok(typeof res.monitoring.totalMonitors === 'number');
      assert.ok(res.incidents);
      assert.ok(typeof res.incidents.totalLast30d === 'number');
      assert.ok(res.remediation);
      assert.ok(res.team);
    });

    it('includes failure type breakdown in incidents', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/team-summary`)).json() as any;
      assert.ok(Array.isArray(res.incidents.byType));
      assert.ok(res.incidents.byType.length > 0);
      assert.ok(res.incidents.byType[0].failureType);
      assert.ok(res.incidents.byType[0].count);
    });

    it('includes severity breakdown', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/reports/team-summary`)).json() as any;
      assert.ok(Array.isArray(res.incidents.bySeverity));
    });
  });

  describe('CSV export', () => {
    it('incident-trends returns CSV with format=csv', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/reports/incident-trends?format=csv`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('period'));
      assert.ok(text.includes('total'));
      assert.ok(text.includes('\n'));
    });

    it('uptime-stats returns CSV with format=csv', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/reports/uptime-stats?monitor_id=${monitorId}&format=csv`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('day'));
      assert.ok(text.includes('uptime'));
    });

    it('playbook-effectiveness returns CSV with format=csv', async () => {
      const allRes = await (await fetch(`http://127.0.0.1:${port}/api/reports/playbook-effectiveness`)).json() as any;
      const playbookId = allRes.entries[0].id;

      const res = await fetch(`http://127.0.0.1:${port}/api/reports/playbook-effectiveness?playbook_id=${playbookId}&format=csv`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('script'));
      assert.ok(text.includes('status'));
    });

    it('team-summary returns CSV with format=csv', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/reports/team-summary?format=csv`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('section'));
      assert.ok(text.includes('metric'));
    });
  });

  describe('Caching behavior', () => {
    it('repeated requests return same data within cache window', async () => {
      const r1 = await (await fetch(`http://127.0.0.1:${port}/api/reports/team-summary`)).json() as any;
      const r2 = await (await fetch(`http://127.0.0.1:${port}/api/reports/team-summary`)).json() as any;
      assert.deepStrictEqual(r1, r2);
    });
  });
});
