import * as http from 'http';
import { Database } from 'sql.js';
import { BillingApi } from '../billing/billing-api';
import { StripeClient } from '../billing/stripe-client';
import { runRemediation, getRemediationLogs, listRuns, approveRun, rejectRun, retryRun, listPolicies, updatePolicy } from '../remediation/engine';
import { getOrCreatePlaybookEntry } from '../playbook';
import { FailureType } from '../classifier';
import { matchPlaybookEntries, getCorrelatedPatterns } from '../playbook/matcher';
import { PerfApi } from '../performance/perf-api';

export interface ApiConfig {
  port: number;
  stripeClient?: StripeClient;
  stripeWebhookSecret?: string;
  baseUrl?: string;
}

export function startApiServer(db: Database, config: ApiConfig): http.Server {
  const billingApi = config.stripeClient ? new BillingApi({
    db,
    stripeClient: config.stripeClient,
    webhookSecret: config.stripeWebhookSecret || '',
    baseUrl: config.baseUrl || 'http://localhost:3000',
  }) : null;

  const perfApi = new PerfApi(db);
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    try {
      if (path === '/api/events' || path === '/api/events/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const type = parsedUrl.searchParams.get('type') || '';
        const severity = parsedUrl.searchParams.get('severity') || '';

        let sql = 'SELECT id, check_id, failure_type, severity, title, description, detected_at, acknowledged FROM failure_events WHERE 1=1';
        const params: any[] = [];

        if (type) {
          sql += ' AND failure_type = ?';
          params.push(type);
        }
        if (severity) {
          sql += ' AND severity = ?';
          params.push(severity);
        }

        sql += ' ORDER BY detected_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const result = db.exec(sql, params);
        const events = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          checkId: row[1],
          failureType: row[2],
          severity: row[3],
          title: row[4],
          description: row[5],
          detectedAt: row[6],
          acknowledged: row[7] === 1,
        })) : [];

        res.end(JSON.stringify({ events, count: events.length, limit, offset }));
        return;
      }

      if (path === '/api/check-results' || path === '/api/check-results/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const status = parsedUrl.searchParams.get('status') || '';

        let sql = 'SELECT id, check_id, status, summary, executed_at FROM check_results WHERE 1=1';
        const params: any[] = [];

        if (status) {
          sql += ' AND status = ?';
          params.push(status);
        }

        sql += ' ORDER BY executed_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const result = db.exec(sql, params);
        const results_list = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          checkId: row[1],
          status: row[2],
          summary: row[3],
          executedAt: row[4],
        })) : [];

        res.end(JSON.stringify({ results: results_list, count: results_list.length, limit, offset }));
        return;
      }

      if (path === '/api/playbook' || path === '/api/playbook/') {
        const result = db.exec(
          'SELECT id, failure_type, title, first_seen_at, last_occurrence_at, occurrence_count FROM playbook_entries ORDER BY last_occurrence_at DESC'
        );
        const entries = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          failureType: row[1],
          title: row[2],
          firstSeenAt: row[3],
          lastOccurrenceAt: row[4],
          occurrenceCount: row[5],
        })) : [];

        res.end(JSON.stringify({ entries, count: entries.length }));
        return;
      }

      if (path === '/api/playbook/search' || path === '/api/playbook/search/') {
        const q = (parsedUrl.searchParams.get('q') || '').toLowerCase();
        if (!q) {
          res.end(JSON.stringify({ entries: [], count: 0, query: q }));
          return;
        }
        const result = db.exec(
          `SELECT id, failure_type, title, first_seen_at, last_occurrence_at, occurrence_count FROM playbook_entries WHERE LOWER(title) LIKE ? OR LOWER(failure_type) LIKE ? ORDER BY last_occurrence_at DESC`,
          [`%${q}%`, `%${q}%`]
        );
        const entries = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          failureType: row[1],
          title: row[2],
          firstSeenAt: row[3],
          lastOccurrenceAt: row[4],
          occurrenceCount: row[5],
        })) : [];
        res.end(JSON.stringify({ entries, count: entries.length, query: q }));
        return;
      }

      if (path === '/api/playbook/match' || path === '/api/playbook/match/') {
        const symptoms = parsedUrl.searchParams.get('symptoms') || '';
        if (!symptoms) {
          res.end(JSON.stringify({ matches: [], count: 0 }));
          return;
        }
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '20', 10), 50);
        const matches = matchPlaybookEntries(db, symptoms, limit);
        res.end(JSON.stringify({ matches, count: matches.length, query: symptoms }));
        return;
      }

      if (path === '/api/playbook/correlations' || path === '/api/playbook/correlations/') {
        const failureType = parsedUrl.searchParams.get('failureType') || '';
        if (!failureType) {
          res.end(JSON.stringify({ correlations: [], count: 0 }));
          return;
        }
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '5', 10), 20);
        const correlations = getCorrelatedPatterns(db, failureType, limit);
        res.end(JSON.stringify({ correlations, count: correlations.length, failureType }));
        return;
      }

      if (path === '/api/playbook/remediate' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { failureType, webhookUrl, tokenEndpoint, clientId, clientSecret, apiEndpoint, newSchemaVersion, currentIntervalSec } = JSON.parse(body);
            if (!failureType) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'failureType is required' }));
              return;
            }
            const entry = getOrCreatePlaybookEntry(db, failureType as FailureType);
            const result = await runRemediation(db, entry, { webhookUrl, tokenEndpoint, clientId, clientSecret, apiEndpoint, newSchemaVersion, currentIntervalSec });
            res.end(JSON.stringify(result));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/playbook/remediation-logs' || path === '/api/playbook/remediation-logs/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const failureType = parsedUrl.searchParams.get('failureType') || undefined;
        const { logs, count } = getRemediationLogs(db, limit, offset, failureType);
        res.end(JSON.stringify({ logs, count, limit, offset }));
        return;
      }

      if (path === '/api/dependencies' || path === '/api/dependencies/') {
        const result = db.exec('SELECT id, name, current_version, specified_range, is_dev, created_at, updated_at FROM dependencies ORDER BY name ASC');
        const dependencies = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          name: row[1],
          currentVersion: row[2],
          specifiedRange: row[3],
          isDev: row[4] === 1,
          createdAt: row[5],
          updatedAt: row[6],
        })) : [];
        res.end(JSON.stringify({ dependencies, count: dependencies.length }));
        return;
      }

      if (path === '/api/dependencies/updates' || path === '/api/dependencies/updates/') {
        const breakingOnly = parsedUrl.searchParams.get('breaking') === 'true';
        let sql = `SELECT du.id, du.dependency_id, du.available_version, du.current_version, du.change_type, du.is_breaking, du.changelog_url, du.detected_at
                   FROM dependency_updates du WHERE 1=1`;
        const params: any[] = [];
        if (breakingOnly) {
          sql += ' AND du.is_breaking = 1';
        }
        sql += ' ORDER BY du.detected_at DESC';
        const result = db.exec(sql, params);
        const updates = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          dependencyId: row[1],
          availableVersion: row[2],
          currentVersion: row[3],
          changeType: row[4],
          isBreaking: row[5] === 1,
          changelogUrl: row[6],
          detectedAt: row[7],
        })) : [];
        res.end(JSON.stringify({ updates, count: updates.length }));
        return;
      }

      if (path === '/api/remediation/policies' || path === '/api/remediation/policies/') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              const policy = listPolicies().find((p: any) => p.id === data.id);
              if (!policy) {
                res.writeHead(404);
                res.end(JSON.stringify({ error: 'Policy not found' }));
                return;
              }
              const updated = updatePolicy(data.id, { auto_approve: data.auto_approve, require_dry_run: data.require_dry_run, cooldown_minutes: data.cooldown_minutes });
              res.end(JSON.stringify({ success: true, policy: updated }));
            } catch (err: any) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        const policies = listPolicies();
        res.end(JSON.stringify({ policies }));
        return;
      }

      if (path === '/api/remediation/approve' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { id } = JSON.parse(body);
            if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id is required' })); return; }
            const result = await approveRun(id);
            res.end(JSON.stringify({ success: true, ...result }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/remediation/reject' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { id } = JSON.parse(body);
            if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id is required' })); return; }
            const result = rejectRun(id);
            res.end(JSON.stringify({ success: true, ...result }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/remediation/retry' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { id } = JSON.parse(body);
            if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'id is required' })); return; }
            const result = await retryRun(id);
            res.end(JSON.stringify({ success: true, ...result }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (billingApi && billingApi.handle(req, res)) {
        return;
      }

      if (perfApi.handle(req, res)) {
        return;
      }

      if (path === '/api/health' || path === '/api/health/') {
        const checkCount = db.exec('SELECT COUNT(*) as count FROM checks');
        const eventCount = db.exec('SELECT COUNT(*) as count FROM failure_events');
        const playbookCount = db.exec('SELECT COUNT(*) as count FROM playbook_entries');

        res.end(JSON.stringify({
          status: 'ok',
          timestamp: new Date().toISOString(),
          stats: {
            checks: checkCount[0]?.values[0]?.[0] || 0,
            failureEvents: eventCount[0]?.values[0]?.[0] || 0,
            playbookEntries: playbookCount[0]?.values[0]?.[0] || 0,
          },
        }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found', available: ['/api/events', '/api/check-results', '/api/playbook', '/api/playbook/search', '/api/playbook/match', '/api/playbook/correlations', '/api/playbook/remediate', '/api/playbook/remediation-logs', '/api/dependencies', '/api/dependencies/updates', '/api/remediation/policies', '/api/remediation/approve', '/api/remediation/reject', '/api/remediation/retry', '/api/health'] }));
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(config.port, () => {
    console.log(`[Nightlamp] API server listening on port ${config.port}`);
  });

  return server;
}