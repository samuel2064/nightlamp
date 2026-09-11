import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';

interface CacheEntry {
  data: any;
  expiry: number;
}

export class ReportsApi {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    try {
      if (path === '/api/reports/incident-trends' && req.method === 'GET') {
        this.handleIncidentTrends(parsedUrl, res);
        return true;
      }

      if (path === '/api/reports/uptime-stats' && req.method === 'GET') {
        this.handleUptimeStats(parsedUrl, res);
        return true;
      }

      if (path === '/api/reports/playbook-effectiveness' && req.method === 'GET') {
        this.handlePlaybookEffectiveness(parsedUrl, res);
        return true;
      }

      if (path === '/api/reports/team-summary' && req.method === 'GET') {
        this.handleTeamSummary(parsedUrl, res);
        return true;
      }
    } catch (err: any) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
      return true;
    }

    return false;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCachedOrFetch(key: string, fetcher: () => any): any {
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiry > now) {
      return cached.data;
    }
    const data = fetcher();
    this.cache.set(key, { data, expiry: now + this.CACHE_TTL_MS });
    return data;
  }

  private parsePeriod(searchParams: URLSearchParams): number {
    const period = searchParams.get('period') || '30d';
    const match = period.match(/^(\d+)([dw])$/);
    if (!match) return 30;
    const num = parseInt(match[1], 10);
    const unit = match[2];
    return unit === 'w' ? num * 7 : num;
  }

  private getGranularity(days: number): string {
    if (days <= 14) return 'hour';
    if (days <= 60) return 'day';
    return 'week';
  }

  private toCSV(columns: string[], rows: any[][]): string {
    const header = columns.join(',');
    const body = rows.map(r => r.map(v => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\n');
    return `${header}\n${body}`;
  }

  private respondJSON(res: ServerResponse, data: any, format?: string): void {
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment');
      res.end(data);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    }
  }

  private handleIncidentTrends(parsedUrl: URL, res: ServerResponse): void {
    const format = parsedUrl.searchParams.get('format') || 'json';
    const periodDays = this.parsePeriod(parsedUrl.searchParams);
    const granularity = this.getGranularity(periodDays);

    const data = this.getCachedOrFetch(`incident-trends:${periodDays}:${granularity}`, () => {
      const dateTrunc = granularity === 'hour'
        ? "strftime('%Y-%m-%dT%H:00:00', detected_at)"
        : granularity === 'week'
          ? "strftime('%Y-%W', detected_at)"
          : "date(detected_at)";

      const results = this.db.exec(`
        SELECT ${dateTrunc} as period,
               failure_type,
               COUNT(*) as count,
               COUNT(DISTINCT check_id) as affected_checks
        FROM failure_events
        WHERE detected_at >= datetime('now', '-${periodDays} days')
        GROUP BY period, failure_type
        ORDER BY period ASC
      `);

      const timeBuckets = new Map<string, Map<string, { count: number; affectedChecks: number }>>();
      const allTypes = new Set<string>();

      if (results.length > 0) {
        for (const row of results[0].values) {
          const period = row[0] as string;
          const failureType = row[1] as string;
          const count = row[2] as number;
          const affectedChecks = row[3] as number;
          allTypes.add(failureType);

          if (!timeBuckets.has(period)) timeBuckets.set(period, new Map());
          timeBuckets.get(period)!.set(failureType, { count, affectedChecks });
        }
      }

      const types = Array.from(allTypes).sort();
      const series = Array.from(timeBuckets.entries()).map(([period, buckets]) => {
        const point: any = { period };
        for (const t of types) {
          point[t] = buckets.get(t)?.count || 0;
          point[`${t}_checks`] = buckets.get(t)?.affectedChecks || 0;
        }
        point.total = types.reduce((s, t) => s + (point[t] || 0), 0);
        return point;
      });

      const nowPeriod = series.length > 0 ? series[series.length - 1] : null;
      const midIdx = Math.floor(series.length / 2);
      const prevPeriod = series.length > 1 ? series[midIdx] : null;

      const comparison = nowPeriod && prevPeriod ? {
        currentPeriod: { label: series[series.length - 1]?.period, total: nowPeriod.total },
        previousPeriod: { label: series[midIdx]?.period, total: prevPeriod.total },
        changePercent: prevPeriod.total > 0
          ? Math.round(((nowPeriod.total - prevPeriod.total) / prevPeriod.total) * 100)
          : null,
      } : null;

      return {
        period: `${periodDays}d`,
        granularity,
        comparison: comparison
          ? { type: periodDays <= 30 ? 'WoW' : 'MoM', ...comparison }
          : null,
        series,
        types,
        total: series.reduce((s, p) => s + p.total, 0),
      };
    });

    if (format === 'csv' && typeof data === 'object') {
      const columns = ['period', ...data.types.flatMap((t: string) => [t, `${t}_checks`]), 'total'];
      const rows = data.series.map((p: any) => columns.map((c: string) => p[c] ?? ''));
      this.respondJSON(res, this.toCSV(columns, rows), 'csv');
    } else {
      this.respondJSON(res, data, 'json');
    }
  }

  private handleUptimeStats(parsedUrl: URL, res: ServerResponse): void {
    const format = parsedUrl.searchParams.get('format') || 'json';
    const periodDays = this.parsePeriod(parsedUrl.searchParams);
    const monitorId = parsedUrl.searchParams.get('monitor_id') || '';

    const data = this.getCachedOrFetch(`uptime-stats:${monitorId}:${periodDays}`, () => {
      if (!monitorId) {
        const allMonitors = this.db.exec(`
          SELECT id, name, source FROM checks WHERE enabled = 1 ORDER BY name
        `);
        const monitors = allMonitors.length > 0
          ? allMonitors[0].values.map((r: any) => ({ id: r[0], name: r[1], source: r[2] }))
          : [];

        const stats = monitors.map((m: any) => {
          const results = this.db.exec(`
            SELECT status, COUNT(*) as cnt
            FROM check_results
            WHERE check_id = ? AND executed_at >= datetime('now', '-${periodDays} days')
            GROUP BY status
          `, [m.id]);

          let total = 0;
          let passed = 0;
          if (results.length > 0) {
            for (const row of results[0].values) {
              const s = row[0] as string;
              const c = row[1] as number;
              total += c;
              if (s === 'pass' || s === 'success') passed += c;
            }
          }

          return {
            monitorId: m.id,
            monitorName: m.name,
            source: m.source,
            uptime: total > 0 ? Math.round((passed / total) * 10000) / 100 : null,
            totalChecks: total,
            passedChecks: passed,
          };
        });

        return { period: `${periodDays}d`, monitorId: null, monitors: stats };
      }

      const monitorInfo = this.db.exec(
        `SELECT id, name, source FROM checks WHERE id = ?`, [monitorId]
      );
      if (monitorInfo.length === 0 || monitorInfo[0].values.length === 0) {
        return { error: 'Monitor not found' };
      }

      const row = monitorInfo[0].values[0];
      const monitorName = row[1] as string;
      const source = row[2] as string;

      const timeResults = this.db.exec(`
        SELECT date(executed_at) as day,
               status,
               COUNT(*) as count
        FROM check_results
        WHERE check_id = ? AND executed_at >= datetime('now', '-${periodDays} days')
        GROUP BY day, status
        ORDER BY day ASC
      `, [monitorId]);

      const dailyMap = new Map<string, { total: number; pass: number; fail: number }>();
      if (timeResults.length > 0) {
        for (const r of timeResults[0].values) {
          const day = r[0] as string;
          const status = r[1] as string;
          const count = r[2] as number;
          if (!dailyMap.has(day)) dailyMap.set(day, { total: 0, pass: 0, fail: 0 });
          const d = dailyMap.get(day)!;
          d.total += count;
          if (status === 'pass' || status === 'success') d.pass += count;
          else d.fail += count;
        }
      }

      const dailySeries = Array.from(dailyMap.entries()).map(([day, d]) => ({
        day,
        uptime: d.total > 0 ? Math.round((d.pass / d.total) * 10000) / 100 : null,
        totalChecks: d.total,
        passedChecks: d.pass,
        failedChecks: d.fail,
      }));

      const respTimeResults = this.db.exec(`
        SELECT cr.executed_at, cr.status
        FROM check_results cr
        WHERE cr.check_id = ? AND cr.executed_at >= datetime('now', '-${periodDays} days')
        ORDER BY cr.executed_at ASC
      `, [monitorId]);

      const responseTimes = respTimeResults.length > 0
        ? respTimeResults[0].values.map((r: any) => ({ timestamp: r[0], status: r[1] }))
        : [];

      const totalCheckCount = responseTimes.length;
      const sorted = [...responseTimes].sort((a, b) => a.status.localeCompare(b.status));
      const p50 = sorted[Math.floor(sorted.length * 0.5)]?.status || '';
      const p95 = sorted[Math.floor(sorted.length * 0.95)]?.status || '';
      const p99 = sorted[Math.floor(sorted.length * 0.99)]?.status || '';

      const uptimePercentile = totalCheckCount > 0
        ? Math.round((responseTimes.filter(r => r.status === 'pass' || r.status === 'success').length / totalCheckCount) * 10000) / 100
        : null;

      return {
        period: `${periodDays}d`,
        monitorId,
        monitorName,
        source,
        summary: {
          uptime: uptimePercentile,
          totalChecks: totalCheckCount,
          passedChecks: responseTimes.filter(r => r.status === 'pass' || r.status === 'success').length,
          failedChecks: responseTimes.filter(r => r.status !== 'pass' && r.status !== 'success').length,
          percentiles: {
            p50,
            p95,
            p99,
          },
        },
        dailySeries,
      };
    });

    if (data.error) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    if (format === 'csv' && typeof data === 'object' && data.dailySeries) {
      const columns = ['day', 'uptime', 'totalChecks', 'passedChecks', 'failedChecks'];
      const rows = data.dailySeries.map((d: any) => [d.day, d.uptime, d.totalChecks, d.passedChecks, d.failedChecks]);
      this.respondJSON(res, this.toCSV(columns, rows), 'csv');
    } else {
      this.respondJSON(res, data, 'json');
    }
  }

  private handlePlaybookEffectiveness(parsedUrl: URL, res: ServerResponse): void {
    const format = parsedUrl.searchParams.get('format') || 'json';
    const playbookId = parsedUrl.searchParams.get('playbook_id') || '';

    const data = this.getCachedOrFetch(`playbook-effectiveness:${playbookId}`, () => {
      if (!playbookId) {
        const allEntries = this.db.exec(`
          SELECT pe.id, pe.failure_type, pe.title, pe.occurrence_count, pe.first_seen_at, pe.last_occurrence_at
          FROM playbook_entries pe
          ORDER BY pe.occurrence_count DESC
        `);

        const entries = allEntries.length > 0
          ? allEntries[0].values.map((r: any) => ({
              id: r[0],
              failureType: r[1],
              title: r[2],
              occurrenceCount: r[3],
              firstSeenAt: r[4],
              lastOccurrenceAt: r[5],
            }))
          : [];

        const enriched = entries.map((e: any) => {
          const remResults = this.db.exec(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successes,
                   SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failures,
                   SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skips
            FROM remediation_log WHERE playbook_entry_id = ?
          `, [e.id]);

          let total = 0, successes = 0, failures = 0, skips = 0;
          if (remResults.length > 0 && remResults[0].values.length > 0) {
            const row = remResults[0].values[0];
            total = (row[0] as number) || 0;
            successes = (row[1] as number) || 0;
            failures = (row[2] as number) || 0;
            skips = (row[3] as number) || 0;
          }

          return {
            ...e,
            remediationStats: {
              totalRuns: total,
              successfulRuns: successes,
              failedRuns: failures,
              skippedRuns: skips,
              successRate: total > 0 ? Math.round((successes / total) * 10000) / 100 : null,
            },
          };
        });

        return { playbookId: null, entries: enriched };
      }

      const entryResult = this.db.exec(`
        SELECT id, failure_type, title, occurrence_count, first_seen_at, last_occurrence_at, body
        FROM playbook_entries WHERE id = ?
      `, [playbookId]);

      if (entryResult.length === 0 || entryResult[0].values.length === 0) {
        return { error: 'Playbook entry not found' };
      }

      const row = entryResult[0].values[0];
      const entry = {
        id: row[0] as string,
        failureType: row[1] as string,
        title: row[2] as string,
        occurrenceCount: row[3] as number,
        firstSeenAt: row[4] as string,
        lastOccurrenceAt: row[5] as string,
        body: row[6] as string,
      };

      const remHistory = this.db.exec(`
        SELECT id, script, status, output, executed_at
        FROM remediation_log
        WHERE playbook_entry_id = ?
        ORDER BY executed_at DESC
      `, [playbookId]);

      const remediationHistory = remHistory.length > 0
        ? remHistory[0].values.map((r: any) => ({
            id: r[0],
            script: r[1],
            status: r[2],
            output: r[3],
            executedAt: r[4],
          }))
        : [];

      const totalRem = remediationHistory.length;
      const successRem = remediationHistory.filter(r => r.status === 'success').length;
      const failedRem = remediationHistory.filter(r => r.status === 'failed').length;

      return {
        playbookId,
        entry,
        remediationStats: {
          totalRuns: totalRem,
          successfulRuns: successRem,
          failedRuns: failedRem,
          skippedRuns: remediationHistory.filter(r => r.status === 'skipped').length,
          successRate: totalRem > 0 ? Math.round((successRem / totalRem) * 10000) / 100 : null,
        },
        remediationHistory,
        effectivenessScore: entry.occurrenceCount > 0
          ? Math.round((1 - (totalRem / entry.occurrenceCount)) * 100) / 100
          : null,
      };
    });

    if (data.error) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }
    if (format === 'csv' && typeof data === 'object' && Array.isArray(data.remediationHistory)) {
      const columns = ['id', 'script', 'status', 'output', 'executedAt'];
      const rows = data.remediationHistory.map((r: any) => [r.id, r.script, r.status, r.output, r.executedAt]);
      this.respondJSON(res, this.toCSV(columns, rows), 'csv');
    } else {
      this.respondJSON(res, data, 'json');
    }
  }

  private handleTeamSummary(parsedUrl: URL, res: ServerResponse): void {
    const format = parsedUrl.searchParams.get('format') || 'json';

    const data = this.getCachedOrFetch('team-summary', () => {
      const teamCount = this.db.exec('SELECT COUNT(*) FROM teams');
      const totalTeams = teamCount.length > 0 ? (teamCount[0].values[0]?.[0] as number) || 0 : 0;

      const monitorCount = this.db.exec('SELECT COUNT(*) FROM checks WHERE enabled = 1');
      const totalMonitors = monitorCount.length > 0 ? (monitorCount[0].values[0]?.[0] as number) || 0 : 0;

      const checkResultCount = this.db.exec("SELECT COUNT(*) FROM check_results WHERE executed_at >= datetime('now', '-30 days')");
      const totalCheckResults = checkResultCount.length > 0 ? (checkResultCount[0].values[0]?.[0] as number) || 0 : 0;

      const incidentCount = this.db.exec("SELECT COUNT(*) FROM failure_events WHERE detected_at >= datetime('now', '-30 days')");
      const totalIncidents = incidentCount.length > 0 ? (incidentCount[0].values[0]?.[0] as number) || 0 : 0;

      const criticalIncidents = this.db.exec("SELECT COUNT(*) FROM failure_events WHERE severity = 'critical' AND detected_at >= datetime('now', '-30 days')");
      const totalCritical = criticalIncidents.length > 0 ? (criticalIncidents[0].values[0]?.[0] as number) || 0 : 0;

      const activeRemediations = this.db.exec("SELECT COUNT(*) FROM remediation_runs WHERE status = 'pending'");
      const totalActiveRemediations = activeRemediations.length > 0 ? (activeRemediations[0].values[0]?.[0] as number) || 0 : 0;

      const failureTypes = this.db.exec(`
        SELECT failure_type, COUNT(*) as cnt
        FROM failure_events
        WHERE detected_at >= datetime('now', '-30 days')
        GROUP BY failure_type
        ORDER BY cnt DESC
      `);

      const failureTypeBreakdown = failureTypes.length > 0
        ? failureTypes[0].values.map((r: any) => ({ failureType: r[0], count: r[1] }))
        : [];

      const bySeverity = this.db.exec(`
        SELECT severity, COUNT(*) as cnt
        FROM failure_events
        WHERE detected_at >= datetime('now', '-30 days')
        GROUP BY severity
      `);

      const severityBreakdown = bySeverity.length > 0
        ? bySeverity[0].values.map((r: any) => ({ severity: r[0], count: r[1] }))
        : [];

      const totalMembers = this.db.exec('SELECT COUNT(*) FROM memberships');
      const memberCount = totalMembers.length > 0 ? (totalMembers[0].values[0]?.[0] as number) || 0 : 0;

      return {
        teams: { total: totalTeams },
        monitoring: {
          totalMonitors,
          totalChecksLast30d: totalCheckResults,
        },
        incidents: {
          totalLast30d: totalIncidents,
          criticalLast30d: totalCritical,
          byType: failureTypeBreakdown,
          bySeverity: severityBreakdown,
        },
        remediation: {
          activeRuns: totalActiveRemediations,
        },
        team: {
          totalMembers: memberCount,
        },
      };
    });

    if (format === 'csv' && typeof data === 'object') {
      const columns = ['section', 'metric', 'value'];
      const rows: any[][] = [];
      const flatten = (prefix: string, obj: any) => {
        for (const [k, v] of Object.entries(obj)) {
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            flatten(`${prefix}.${k}`, v);
          } else if (Array.isArray(v)) {
            v.forEach((item: any, i: number) => {
              if (typeof item === 'object') {
                flatten(`${prefix}.${k}[${i}]`, item);
              } else {
                rows.push([prefix, `${k}[${i}]`, item]);
              }
            });
          } else {
            rows.push([prefix, k, v]);
          }
        }
      };
      flatten('summary', data);
      this.respondJSON(res, this.toCSV(columns, rows), 'csv');
    } else {
      this.respondJSON(res, data, 'json');
    }
  }
}
