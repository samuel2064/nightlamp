import * as http from 'http';
import { Database } from 'sql.js';
import { BillingApi } from '../billing/billing-api';
import { StripeClient } from '../billing/stripe-client';
import { runRemediation, getRemediationLogs, listRuns, approveRun, rejectRun, retryRun, listPolicies, updatePolicy } from '../remediation/engine';
import { getOrCreatePlaybookEntry } from '../playbook';
import { FailureType } from '../classifier';
import { matchPlaybookEntries, getCorrelatedPatterns } from '../playbook/matcher';
import { PerfApi } from '../performance/perf-api';
import { handleClerkWebhook } from '../webhooks/clerk';
import * as fs from 'fs';
import * as nodePath from 'path';
import { v4 as uuidv4 } from 'uuid';
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken, postThread, verifyCredentials, parseLaunchThread, XConfig } from '../connectors/x';

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

      if (handleClerkWebhook(req, res)) {
        return;
      }

      if (path === '/api/alerting/channels' || path === '/api/alerting/channels/') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const { name, type, config } = JSON.parse(body);
              if (!name || !type || !config) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'name, type, and config are required' }));
                return;
              }
              if (!['slack', 'email', 'pagerduty'].includes(type)) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'type must be slack, email, or pagerduty' }));
                return;
              }
              const id = uuidv4();
              db.run(
                `INSERT INTO alert_channels (id, name, type, config) VALUES (?, ?, ?, ?)`,
                [id, name, type, JSON.stringify(config)]
              );
              res.end(JSON.stringify({ success: true, id, name, type }));
            } catch (err: any) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        const result = db.exec('SELECT id, name, type, enabled, created_at FROM alert_channels ORDER BY created_at DESC');
        const channels = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0], name: row[1], type: row[2], enabled: row[3] === 1, createdAt: row[4],
        })) : [];
        res.end(JSON.stringify({ channels, count: channels.length }));
        return;
      }

      if (path.startsWith('/api/alerting/channels/') && req.method === 'DELETE') {
        const channelId = path.split('/').pop();
        if (!channelId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Channel ID required' })); return; }
        db.run('DELETE FROM alert_rules WHERE channel_id = ?', [channelId]);
        db.run('DELETE FROM alert_channels WHERE id = ?', [channelId]);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (path.startsWith('/api/alerting/channels/') && req.method === 'PUT') {
        const channelId = path.split('/').pop();
        if (!channelId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Channel ID required' })); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { name, config, enabled } = JSON.parse(body);
            const updates: string[] = [];
            const params: any[] = [];
            if (name !== undefined) { updates.push('name = ?'); params.push(name); }
            if (config !== undefined) { updates.push('config = ?'); params.push(JSON.stringify(config)); }
            if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
            if (updates.length > 0) {
              updates.push("updated_at = datetime('now')");
              db.run(`UPDATE alert_channels SET ${updates.join(', ')} WHERE id = ?`, [...params, channelId]);
            }
            res.end(JSON.stringify({ success: true }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/alerting/rules' || path === '/api/alerting/rules/') {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', () => {
            try {
              const { name, channelId, failureTypes, minSeverity } = JSON.parse(body);
              if (!name || !channelId || !failureTypes) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'name, channelId, and failureTypes are required' }));
                return;
              }
              const id = uuidv4();
              db.run(
                `INSERT INTO alert_rules (id, name, channel_id, failure_types, min_severity) VALUES (?, ?, ?, ?, ?)`,
                [id, name, channelId, JSON.stringify(failureTypes), minSeverity || 'info']
              );
              res.end(JSON.stringify({ success: true, id, name, channelId, failureTypes, minSeverity: minSeverity || 'info' }));
            } catch (err: any) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        const result = db.exec(
          `SELECT ar.id, ar.name, ar.channel_id, ar.failure_types, ar.min_severity, ar.enabled, ac.name as channel_name, ac.type as channel_type
           FROM alert_rules ar LEFT JOIN alert_channels ac ON ar.channel_id = ac.id
           ORDER BY ar.created_at DESC`
        );
        const rules = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0], name: row[1], channelId: row[2],
          failureTypes: JSON.parse(row[3] as string),
          minSeverity: row[4], enabled: row[5] === 1,
          channelName: row[6], channelType: row[7],
        })) : [];
        res.end(JSON.stringify({ rules, count: rules.length }));
        return;
      }

      if (path.startsWith('/api/alerting/rules/') && req.method === 'DELETE') {
        const ruleId = path.split('/').pop();
        if (!ruleId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Rule ID required' })); return; }
        db.run('DELETE FROM alert_rules WHERE id = ?', [ruleId]);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (path.startsWith('/api/alerting/rules/') && req.method === 'PUT') {
        const ruleId = path.split('/').pop();
        if (!ruleId) { res.writeHead(400); res.end(JSON.stringify({ error: 'Rule ID required' })); return; }
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { name, channelId, failureTypes, minSeverity, enabled } = JSON.parse(body);
            const updates: string[] = [];
            const params: any[] = [];
            if (name !== undefined) { updates.push('name = ?'); params.push(name); }
            if (channelId !== undefined) { updates.push('channel_id = ?'); params.push(channelId); }
            if (failureTypes !== undefined) { updates.push('failure_types = ?'); params.push(JSON.stringify(failureTypes)); }
            if (minSeverity !== undefined) { updates.push('min_severity = ?'); params.push(minSeverity); }
            if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
            if (updates.length > 0) {
              updates.push("updated_at = datetime('now')");
              db.run(`UPDATE alert_rules SET ${updates.join(', ')} WHERE id = ?`, [...params, ruleId]);
            }
            res.end(JSON.stringify({ success: true }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/alerting/log' || path === '/api/alerting/log/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const result = db.exec(
          `SELECT al.id, al.rule_id, al.channel_id, al.failure_event_id, al.failure_type, al.severity, al.channel_type, al.status, al.error_message, al.sent_at, ar.name as rule_name, ac.name as channel_name
           FROM alert_log al
           LEFT JOIN alert_rules ar ON al.rule_id = ar.id
           LEFT JOIN alert_channels ac ON al.channel_id = ac.id
           ORDER BY al.sent_at DESC LIMIT ? OFFSET ?`,
          [limit, offset]
        );
        const logs = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0], ruleId: row[1], channelId: row[2], failureEventId: row[3],
          failureType: row[4], severity: row[5], channelType: row[6],
          status: row[7], errorMessage: row[8], sentAt: row[9],
          ruleName: row[10], channelName: row[11],
        })) : [];
        res.end(JSON.stringify({ logs, count: logs.length, limit, offset }));
        return;
      }

      if (path === '/api/x/auth' || path === '/api/x/auth/') {
        const clientId = process.env.X_CLIENT_ID || '';
        const clientSecret = process.env.X_CLIENT_SECRET || '';
        const callbackUrl = process.env.X_CALLBACK_URL || 'http://localhost:3001/api/x/callback';

        if (!clientId || !clientSecret) {
          res.end(JSON.stringify({ error: 'X/Twitter not configured (set X_CLIENT_ID, X_CLIENT_SECRET)' }));
          return;
        }

        const config: XConfig = { clientId, clientSecret, callbackUrl };
        const { url, codeVerifier, state } = buildAuthorizeUrl(config);

        db.run(
          `INSERT INTO x_tokens (id, access_token, refresh_token, scope, expires_at) VALUES (?, ?, ?, ?, ?)`,
          ['pkce_state', codeVerifier, state, 'pending', null]
        );

        res.end(JSON.stringify({ authorizeUrl: url, state }));
        return;
      }

      if (path === '/api/x/callback' || path === '/api/x/callback/') {
        const code = parsedUrl.searchParams.get('code') || '';
        const state = parsedUrl.searchParams.get('state') || '';

        if (!code || !state) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing code or state parameter' }));
          return;
        }

        const clientId = process.env.X_CLIENT_ID || '';
        const clientSecret = process.env.X_CLIENT_SECRET || '';
        const callbackUrl = process.env.X_CALLBACK_URL || 'http://localhost:3001/api/x/callback';
        const config: XConfig = { clientId, clientSecret, callbackUrl };

        (async () => {
          try {
            const stored = db.exec('SELECT access_token FROM x_tokens WHERE id = ?', ['pkce_state']);
            const savedVerifier = stored.length > 0 ? stored[0].values[0]?.[0] as string : '';

            const tokenResponse = await exchangeCodeForToken(config, code, savedVerifier);
            const expiresAt = new Date(Date.now() + tokenResponse.expiresIn * 1000).toISOString();

            db.run('DELETE FROM x_tokens WHERE id = ?', ['pkce_state']);
            db.run(
              `INSERT INTO x_tokens (id, access_token, refresh_token, scope, expires_at) VALUES (?, ?, ?, ?, ?)`,
              ['active', tokenResponse.accessToken, tokenResponse.refreshToken, tokenResponse.scope, expiresAt]
            );

            res.end(JSON.stringify({ success: true, message: 'X/Twitter authenticated successfully', expiresAt }));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `OAuth callback failed: ${err.message}` }));
          }
        })();
        return;
      }

      if (path === '/api/x/status' || path === '/api/x/status/') {
        (async () => {
          const tokenResult = db.exec('SELECT access_token, refresh_token, expires_at, created_at FROM x_tokens WHERE id = ?', ['active']);
          if (tokenResult.length === 0 || tokenResult[0].values.length === 0) {
            res.end(JSON.stringify({ authenticated: false }));
            return;
          }
          const row = tokenResult[0].values[0];
          const accessToken = row[0] as string;
          const refreshToken = row[1] as string;
          const expiresAt = row[2] as string;
          const createdAt = row[3] as string;
          const expired = expiresAt ? new Date(expiresAt) < new Date() : false;

          let valid = false;
          try {
            valid = await verifyCredentials(accessToken);
          } catch { }

          res.end(JSON.stringify({
            authenticated: valid,
            hasRefreshToken: !!refreshToken,
            expiresAt,
            expired,
            createdAt,
            canRefresh: !valid && !!refreshToken,
          }));
        })();
        return;
      }

      if (path === '/api/x/refresh' || path === '/api/x/refresh/') {
        const clientId = process.env.X_CLIENT_ID || '';
        const clientSecret = process.env.X_CLIENT_SECRET || '';
        const callbackUrl = process.env.X_CALLBACK_URL || 'http://localhost:3001/api/x/callback';
        const config: XConfig = { clientId, clientSecret, callbackUrl };

        (async () => {
          try {
            const tokenResult = db.exec('SELECT refresh_token FROM x_tokens WHERE id = ?', ['active']);
            if (tokenResult.length === 0 || tokenResult[0].values.length === 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'No tokens to refresh' }));
              return;
            }
            const oldRefreshToken = tokenResult[0].values[0][0] as string;
            const tokenResponse = await refreshAccessToken(config, oldRefreshToken);
            const expiresAt = new Date(Date.now() + tokenResponse.expiresIn * 1000).toISOString();

            db.run('DELETE FROM x_tokens WHERE id = ?', ['active']);
            db.run(
              `INSERT INTO x_tokens (id, access_token, refresh_token, scope, expires_at) VALUES (?, ?, ?, ?, ?)`,
              ['active', tokenResponse.accessToken, tokenResponse.refreshToken, tokenResponse.scope, expiresAt]
            );

            res.end(JSON.stringify({ success: true, message: 'Token refreshed', expiresAt }));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Token refresh failed: ${err.message}` }));
          }
        })();
        return;
      }

      if (path === '/api/x/post' || path === '/api/x/post/') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', async () => {
          try {
            const { tweets } = JSON.parse(body);
            if (!tweets || !Array.isArray(tweets) || tweets.length === 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'tweets array is required' }));
              return;
            }

            const tokenResult = db.exec('SELECT access_token FROM x_tokens WHERE id = ?', ['active']);
            if (tokenResult.length === 0 || tokenResult[0].values.length === 0) {
              res.writeHead(401);
              res.end(JSON.stringify({ error: 'Not authenticated. Visit /api/x/auth first.' }));
              return;
            }
            const accessToken = tokenResult[0].values[0][0] as string;

            const results = await postThread(accessToken, tweets);

            for (let i = 0; i < results.length; i++) {
              const postId = uuidv4();
              db.run(
                `INSERT INTO x_scheduled_posts (id, tweet_text, position, tweet_id, status, posted_at) VALUES (?, ?, ?, ?, 'posted', datetime('now'))`,
                [postId, results[i].text, i + 1, results[i].tweetId]
              );
            }

            res.end(JSON.stringify({ success: true, thread: results }));
          } catch (err: any) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Post failed: ${err.message}` }));
          }
        });
        return;
      }

      if (path === '/api/x/schedule' || path === '/api/x/schedule/') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { tweets, scheduledAt } = JSON.parse(body);
            if (!tweets || !Array.isArray(tweets) || tweets.length === 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'tweets array is required' }));
              return;
            }
            if (!scheduledAt) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'scheduledAt (ISO 8601) is required' }));
              return;
            }

            const scheduled = new Date(scheduledAt);
            if (isNaN(scheduled.getTime())) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'scheduledAt must be a valid ISO 8601 date' }));
              return;
            }

            const ids: string[] = [];
            for (let i = 0; i < tweets.length; i++) {
              const postId = uuidv4();
              db.run(
                `INSERT INTO x_scheduled_posts (id, tweet_text, position, scheduled_at, status) VALUES (?, ?, ?, ?, 'pending')`,
                [postId, tweets[i], i + 1, scheduled.toISOString()]
              );
              ids.push(postId);
            }

            res.end(JSON.stringify({ success: true, postIds: ids, scheduledAt: scheduled.toISOString(), count: tweets.length }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/x/schedule-thread' || path === '/api/x/schedule-thread/') {
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          try {
            const { scheduledAt } = JSON.parse(body);
            if (!scheduledAt) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'scheduledAt (ISO 8601) is required' }));
              return;
            }

            const scheduled = new Date(scheduledAt);
            if (isNaN(scheduled.getTime())) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'scheduledAt must be a valid ISO 8601 date' }));
              return;
            }

            const threadFile = process.env.X_LAUNCH_THREAD_FILE || './docs/marketing/build-in-public-content.md';
            const fullPath = nodePath.resolve(threadFile);
            if (!fs.existsSync(fullPath)) {
              res.writeHead(404);
              res.end(JSON.stringify({ error: `Launch thread file not found: ${fullPath}` }));
              return;
            }

            const content = fs.readFileSync(fullPath, 'utf-8');
            const tweets = parseLaunchThread(content);

            if (tweets.length === 0) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'No tweets found in launch thread file' }));
              return;
            }

            const ids: string[] = [];
            for (let i = 0; i < tweets.length; i++) {
              const postId = uuidv4();
              db.run(
                `INSERT INTO x_scheduled_posts (id, tweet_text, position, scheduled_at, status) VALUES (?, ?, ?, ?, 'pending')`,
                [postId, tweets[i], i + 1, scheduled.toISOString()]
              );
              ids.push(postId);
            }

            res.end(JSON.stringify({
              success: true,
              postIds: ids,
              scheduledAt: scheduled.toISOString(),
              count: tweets.length,
              source: fullPath,
            }));
          } catch (err: any) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      if (path === '/api/x/posts' || path === '/api/x/posts/') {
        const result = db.exec(
          'SELECT id, tweet_text, position, tweet_id, status, error, posted_at, created_at FROM x_scheduled_posts ORDER BY position ASC'
        );
        const posts = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          text: row[1],
          position: row[2],
          tweetId: row[3],
          status: row[4],
          error: row[5],
          postedAt: row[6],
          createdAt: row[7],
        })) : [];
        res.end(JSON.stringify({ posts, count: posts.length }));
        return;
      }

      if (path === '/api/monitors' || path === '/api/monitors/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const enabled = parsedUrl.searchParams.get('enabled');

        let sql = 'SELECT id, source, name, config, enabled, created_at, updated_at FROM checks WHERE 1=1';
        const params: any[] = [];

        if (enabled !== null) {
          sql += ' AND enabled = ?';
          params.push(enabled === 'true' ? 1 : 0);
        }

        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const result = db.exec(sql, params);
        const monitors = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          source: row[1],
          name: row[2],
          config: JSON.parse(row[3]),
          enabled: row[4] === 1,
          createdAt: row[5],
          updatedAt: row[6],
        })) : [];

        res.end(JSON.stringify({ monitors, count: monitors.length, limit, offset }));
        return;
      }

      if (path === '/api/incidents' || path === '/api/incidents/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const status = parsedUrl.searchParams.get('status');
        const severity = parsedUrl.searchParams.get('severity');

        let sql = `SELECT fe.id, fe.check_id, fe.failure_type, fe.severity, fe.title, fe.description, 
                          fe.raw_data, fe.detected_at, fe.acknowledged,
                          c.name as check_name, c.source as check_source
                   FROM failure_events fe
                   LEFT JOIN checks c ON fe.check_id = c.id
                   WHERE 1=1`;
        const params: any[] = [];

        if (status === 'acknowledged') {
          sql += ' AND fe.acknowledged = 1';
        } else if (status === 'unacknowledged') {
          sql += ' AND fe.acknowledged = 0';
        }
        if (severity) {
          sql += ' AND fe.severity = ?';
          params.push(severity);
        }

        sql += ' ORDER BY fe.detected_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const result = db.exec(sql, params);
        const incidents = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          checkId: row[1],
          failureType: row[2],
          severity: row[3],
          title: row[4],
          description: row[5],
          rawData: row[6] ? JSON.parse(row[6]) : null,
          detectedAt: row[7],
          acknowledged: row[8] === 1,
          checkName: row[9],
          checkSource: row[10],
        })) : [];

        res.end(JSON.stringify({ incidents, count: incidents.length, limit, offset }));
        return;
      }

      if (path === '/api/dependency-health' || path === '/api/dependency-health/') {
        const result = db.exec(`
          SELECT d.id, d.name, d.current_version, d.specified_range, d.is_dev, d.created_at, d.updated_at,
                 COALESCE(du.breaking_count, 0) as breaking_updates,
                 COALESCE(du.total_count, 0) as total_updates,
                 du.latest_version,
                 du.latest_change_type,
                 du.latest_detected_at
          FROM dependencies d
          LEFT JOIN (
            SELECT dependency_id,
                   COUNT(*) as total_count,
                   SUM(is_breaking) as breaking_count,
                   MAX(available_version) as latest_version,
                   MAX(CASE WHEN detected_at = (SELECT MAX(detected_at) FROM dependency_updates WHERE dependency_id = du2.dependency_id) THEN change_type END) as latest_change_type,
                   MAX(detected_at) as latest_detected_at
            FROM dependency_updates
            GROUP BY dependency_id
          ) du ON d.id = du.dependency_id
          ORDER BY breaking_updates DESC, total_updates DESC
        `);

        const dependencyHealth = result.length > 0 ? result[0].values.map((row: any) => ({
          id: row[0],
          name: row[1],
          currentVersion: row[2],
          specifiedRange: row[3],
          isDev: row[4] === 1,
          createdAt: row[5],
          updatedAt: row[6],
          breakingUpdates: row[7],
          totalUpdates: row[8],
          latestVersion: row[9],
          latestChangeType: row[10],
          latestDetectedAt: row[11],
          status: row[7] > 0 ? 'breaking' : (row[8] > 0 ? 'updates_available' : 'up_to_date'),
        })) : [];

        res.end(JSON.stringify({ dependencies: dependencyHealth, count: dependencyHealth.length }));
        return;
      }

      if (path === '/api/activity' || path === '/api/activity/') {
        const limit = Math.min(parseInt(parsedUrl.searchParams.get('limit') || '50', 10), 200);
        const offset = parseInt(parsedUrl.searchParams.get('offset') || '0', 10);
        const type = parsedUrl.searchParams.get('type');

        const activities: any[] = [];

        if (!type || type === 'check_result') {
          const crResult = db.exec(`
            SELECT cr.id, cr.check_id, cr.status, cr.summary, cr.executed_at, c.name as check_name, c.source
            FROM check_results cr
            LEFT JOIN checks c ON cr.check_id = c.id
            ORDER BY cr.executed_at DESC LIMIT ? OFFSET ?
          `, [limit, offset]);

          if (crResult.length > 0) {
            crResult[0].values.forEach((row: any) => {
              activities.push({
                id: row[0],
                type: 'check_result',
                checkId: row[1],
                status: row[2],
                summary: row[3],
                timestamp: row[4],
                checkName: row[5],
                checkSource: row[6],
              });
            });
          }
        }

        if (!type || type === 'failure_event') {
          const feResult = db.exec(`
            SELECT fe.id, fe.check_id, fe.failure_type, fe.severity, fe.title, fe.detected_at, c.name as check_name, c.source
            FROM failure_events fe
            LEFT JOIN checks c ON fe.check_id = c.id
            ORDER BY fe.detected_at DESC LIMIT ? OFFSET ?
          `, [limit, offset]);

          if (feResult.length > 0) {
            feResult[0].values.forEach((row: any) => {
              activities.push({
                id: row[0],
                type: 'failure_event',
                checkId: row[1],
                failureType: row[2],
                severity: row[3],
                title: row[4],
                timestamp: row[5],
                checkName: row[6],
                checkSource: row[7],
              });
            });
          }
        }

        if (!type || type === 'dependency_update') {
          const duResult = db.exec(`
            SELECT du.id, du.dependency_id, du.available_version, du.current_version, du.change_type, du.is_breaking, du.detected_at, d.name as dependency_name
            FROM dependency_updates du
            LEFT JOIN dependencies d ON du.dependency_id = d.id
            ORDER BY du.detected_at DESC LIMIT ? OFFSET ?
          `, [limit, offset]);

          if (duResult.length > 0) {
            duResult[0].values.forEach((row: any) => {
              activities.push({
                id: row[0],
                type: 'dependency_update',
                dependencyId: row[1],
                availableVersion: row[2],
                currentVersion: row[3],
                changeType: row[4],
                isBreaking: row[5] === 1,
                timestamp: row[6],
                dependencyName: row[7],
              });
            });
          }
        }

        activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const paginated = activities.slice(0, limit);

        res.end(JSON.stringify({ activities: paginated, count: paginated.length, limit, offset }));
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
      res.end(JSON.stringify({ error: 'Not found', available: ['/api/events', '/api/check-results', '/api/playbook', '/api/playbook/search', '/api/playbook/match', '/api/playbook/correlations', '/api/playbook/remediate', '/api/playbook/remediation-logs', '/api/dependencies', '/api/dependencies/updates', '/api/remediation/policies', '/api/remediation/approve', '/api/remediation/reject', '/api/remediation/retry', '/api/alerting/channels', '/api/alerting/rules', '/api/alerting/log', '/api/x/auth', '/api/x/callback', '/api/x/status', '/api/x/refresh', '/api/x/schedule', '/api/x/schedule-thread', '/api/x/post', '/api/x/posts', '/api/health', '/api/monitors', '/api/incidents', '/api/dependency-health', '/api/activity', '/api/webhooks/clerk'] }));
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