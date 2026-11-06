import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';
import {
  SentryConfig,
  SentryIssue,
  pollSentry,
  detectSpikes,
  detectNewPatterns,
  isSentryConfigPlaceholder,
  isUptimeRobotConfigPlaceholder,
} from '../connectors';
import { UptimeRobotConfig, UptimeRobotMonitor, pollUptimeRobot, detectStatusChanges, detectSSLIssues } from '../connectors';
import { classifyFailure, FailureType } from '../classifier';
import { getOrCreatePlaybookEntry, writePlaybookFile } from '../playbook';
import { runRemediation } from '../remediation/engine';
import { evaluateAndNotify } from '../alerting';

export interface HealthCheckConfig {
  sentry?: SentryConfig;
  uptimerobot?: UptimeRobotConfig;
  pollIntervalSec: number;
  dbPath: string;
  playbookDir: string;
}

export interface CheckRunResult {
  checkId: string;
  status: 'pass' | 'fail' | 'error';
  summary: string;
  failureEvents: number;
  playbookEntries: string[];
  issues: SentryIssue[];
  monitors: UptimeRobotMonitor[];
}

export interface CheckConfigLike {
  [key: string]: unknown;
}

/**
 * Get or create the single monitor row for an integration source.
 *
 * A poll run is not a monitor: previously every run inserted a fresh `checks`
 * row, which produced a new duplicate monitor every minute. The check row is
 * now stable per (source, name) and only its config is refreshed.
 */
export function ensureCheck(
  db: Database,
  source: string,
  name: string,
  config: object
): string {
  const configJson = JSON.stringify(config);
  const existing = db.exec(
    'SELECT id, config FROM checks WHERE source = ? AND name = ? ORDER BY created_at ASC, id ASC LIMIT 1',
    [source, name]
  );

  let checkId: string;
  if (existing.length > 0 && existing[0].values.length > 0) {
    checkId = existing[0].values[0][0] as string;
    const previousConfig = existing[0].values[0][1] as string;
    if (previousConfig !== configJson) {
      db.run(
        `UPDATE checks SET config = ?, enabled = 1, updated_at = datetime('now') WHERE id = ?`,
        [configJson, checkId]
      );
    }
  } else {
    checkId = uuidv4();
    db.run(
      'INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, 1)',
      [checkId, source, name, configJson]
    );
  }

  db.run(
    `UPDATE checks SET enabled = 0, updated_at = datetime('now')
     WHERE source = ? AND name = ? AND id <> ? AND enabled = 1`,
    [source, name, checkId]
  );

  return checkId;
}

/**
 * Collapse pre-existing duplicate monitor rows, keeping one enabled row per
 * (source, name). Older deployments created one row per poll interval.
 */
export function deduplicateChecks(db: Database): number {
  const result = db.exec(
    'SELECT id, source, name, enabled FROM checks ORDER BY created_at ASC, id ASC'
  );
  if (result.length === 0 || result[0].values.length === 0) return 0;

  const groups = new Map<string, { id: string; enabled: boolean }[]>();
  for (const row of result[0].values) {
    const key = `${row[1]}\u0000${row[2]}`;
    const group = groups.get(key) || [];
    group.push({ id: row[0] as string, enabled: Number(row[3]) === 1 });
    groups.set(key, group);
  }

  let disabled = 0;
  for (const rows of groups.values()) {
    if (rows.length <= 1) continue;
    const keeper = rows.find((r) => r.enabled) || rows[0];
    for (const row of rows) {
      if (row.id === keeper.id || !row.enabled) continue;
      db.run(`UPDATE checks SET enabled = 0, updated_at = datetime('now') WHERE id = ?`, [row.id]);
      disabled++;
    }
  }
  return disabled;
}

/** Disable monitors whose stored config still contains placeholder credentials. */
export function disablePlaceholderChecks(db: Database): number {
  const result = db.exec(
    'SELECT id, source, config FROM checks WHERE enabled = 1'
  );
  if (result.length === 0 || result[0].values.length === 0) return 0;

  let disabled = 0;
  for (const row of result[0].values) {
    const id = row[0] as string;
    const source = row[1] as string;
    let config: CheckConfigLike | null = null;
    try {
      config = JSON.parse(row[2] as string);
    } catch {
      config = null;
    }

    const placeholder = source === 'sentry'
      ? isSentryConfigPlaceholder(config as Partial<SentryConfig> | null)
      : source === 'uptimerobot'
        ? isUptimeRobotConfigPlaceholder(config as Partial<UptimeRobotConfig> | null)
        : false;

    if (placeholder) {
      db.run(`UPDATE checks SET enabled = 0, updated_at = datetime('now') WHERE id = ?`, [id]);
      disabled++;
    }
  }
  return disabled;
}

/** Apply one-time monitor hygiene: dedupe rows, then disable placeholder configs. */
export function sanitizeChecks(db: Database): { duplicatesDisabled: number; placeholdersDisabled: number } {
  const duplicatesDisabled = deduplicateChecks(db);
  const placeholdersDisabled = disablePlaceholderChecks(db);
  return { duplicatesDisabled, placeholdersDisabled };
}

async function autoRemediateOnRecurrence(
  db: Database,
  checkId: string,
  entry: { id: string; failureType: FailureType; occurrenceCount: number },
  failureType: string,
  playbookDir: string,
  events: string[],
): Promise<number> {
  let extraFailures = 0;
  if (entry.occurrenceCount >= 2) {
    const remediationResult = await runRemediation(db, entry as any);
    const remEventId = uuidv4();
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, 'remediation_triggered', 'info', ?, ?, ?)`,
      [remEventId, checkId, `Auto-remediation for ${failureType}: ${remediationResult.status}`, remediationResult.output, JSON.stringify(remediationResult)]
    );

    await evaluateAndNotify(db, 'remediation_triggered', 'info', `Auto-remediation for ${failureType}: ${remediationResult.status}`, remediationResult.output, new Date().toISOString(), checkId, remEventId).catch((err: any) => {
      console.error(`[Alerting] Failed to send notification for remediation ${remEventId}: ${err.message}`);
    });

    const remEntry = getOrCreatePlaybookEntry(db, 'remediation_triggered' as FailureType);
    const remFilePath = writePlaybookFile(playbookDir, remEntry);
    events.push(remFilePath);
    extraFailures++;
  }
  return extraFailures;
}

export async function runSentryCheck(
  db: Database,
  config: SentryConfig,
  previousIssues: SentryIssue[],
  playbookDir: string
): Promise<CheckRunResult> {
  const events: string[] = [];
  let failureCount = 0;

  const checkId = ensureCheck(db, 'sentry', 'Sentry Error Monitor', config);

  const result = await pollSentry(config);

  if (result.error) {
    db.run(
      `INSERT INTO check_results (id, check_id, status, summary, details, raw_data) VALUES (?, ?, 'error', ?, ?, ?)`,
      [uuidv4(), checkId, result.error, result.error, JSON.stringify(result)]
    );

    const classification = classifyFailure(checkId, {
      statusCode: 500,
      errorMessage: result.error,
    });

    for (const event of classification) {
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [event.id, checkId, event.failureType, event.severity, event.title, event.description, JSON.stringify(event.rawData)]
      );

      await evaluateAndNotify(db, event.failureType, event.severity, event.title, event.description, event.detectedAt, checkId, event.id).catch((err: any) => {
        console.error(`[Alerting] Failed to send notification for event ${event.id}: ${err.message}`);
      });

      const entry = getOrCreatePlaybookEntry(db, event.failureType);
      const filePath = writePlaybookFile(playbookDir, entry);
      events.push(filePath);
      failureCount++;
      failureCount += await autoRemediateOnRecurrence(db, checkId, entry, event.failureType, playbookDir, events);
    }

    return { checkId, status: 'error', summary: result.error, failureEvents: failureCount, playbookEntries: events, issues: result.issues, monitors: [] };
  }

  const spikes = detectSpikes(result.issues, previousIssues);
  const newPatterns = detectNewPatterns(result.issues, previousIssues);

  if (spikes.length > 0) {
    for (const issue of spikes) {
      const eventId = uuidv4();
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, 'error_spike', 'warning', ?, ?, ?)`,
        [eventId, checkId, `Error spike detected: ${issue.title} (${issue.count} occurrences)`, `Issue ${issue.permalink} spiked from previous count`, JSON.stringify(issue)]
      );

      await evaluateAndNotify(db, 'error_spike', 'warning', `Error spike detected: ${issue.title}`, `Issue ${issue.permalink} spiked from previous count`, new Date().toISOString(), checkId, eventId).catch((err: any) => {
        console.error(`[Alerting] Failed to send notification for spike ${eventId}: ${err.message}`);
      });

      const entry = getOrCreatePlaybookEntry(db, 'error_spike' as FailureType);
      const filePath = writePlaybookFile(playbookDir, entry);
      events.push(filePath);
      failureCount++;
      failureCount += await autoRemediateOnRecurrence(db, checkId, entry, 'error_spike', playbookDir, events);
    }
  }

  if (newPatterns.length > 0) {
    for (const issue of newPatterns) {
      const eventId = uuidv4();
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, 'new_error_pattern', 'info', ?, ?, ?)`,
        [eventId, checkId, `New error pattern: ${issue.title}`, `First occurrence of ${issue.title} at ${issue.permalink}`, JSON.stringify(issue)]
      );

      await evaluateAndNotify(db, 'new_error_pattern', 'info', `New error pattern: ${issue.title}`, `First occurrence of ${issue.title} at ${issue.permalink}`, new Date().toISOString(), checkId, eventId).catch((err: any) => {
        console.error(`[Alerting] Failed to send notification for new pattern ${eventId}: ${err.message}`);
      });

      const entry = getOrCreatePlaybookEntry(db, 'new_error_pattern' as FailureType);
      const filePath = writePlaybookFile(playbookDir, entry);
      events.push(filePath);
      failureCount++;
      failureCount += await autoRemediateOnRecurrence(db, checkId, entry, 'new_error_pattern', playbookDir, events);
    }
  }

  const status: 'pass' | 'fail' = failureCount > 0 ? 'fail' : 'pass';
  db.run(
    `INSERT INTO check_results (id, check_id, status, summary, details, raw_data) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), checkId, status, `${result.issues.length} issues found, ${spikes.length} spikes, ${newPatterns.length} new patterns`, JSON.stringify({ spikes: spikes.length, newPatterns: newPatterns.length }), JSON.stringify(result)]
  );

  return {
    checkId,
    status,
    summary: `${result.issues.length} issues, ${spikes.length} spikes, ${newPatterns.length} new patterns`,
    failureEvents: failureCount,
    playbookEntries: events,
    issues: result.issues,
    monitors: [],
  };
}

export async function runUptimeRobotCheck(
  db: Database,
  config: UptimeRobotConfig,
  previousMonitors: UptimeRobotMonitor[],
  playbookDir: string
): Promise<CheckRunResult> {
  const events: string[] = [];
  let failureCount = 0;

  const checkId = ensureCheck(db, 'uptimerobot', 'UptimeRobot Monitor', config);

  const result = await pollUptimeRobot(config);

  if (result.error) {
    db.run(
      `INSERT INTO check_results (id, check_id, status, summary, details, raw_data) VALUES (?, ?, 'error', ?, ?, ?)`,
      [uuidv4(), checkId, result.error, result.error, JSON.stringify(result)]
    );

    const classification = classifyFailure(checkId, {
      statusCode: 500,
      errorMessage: result.error,
    });

    for (const event of classification) {
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [event.id, checkId, event.failureType, event.severity, event.title, event.description, JSON.stringify(event.rawData)]
      );

      await evaluateAndNotify(db, event.failureType, event.severity, event.title, event.description, event.detectedAt, checkId, event.id).catch((err: any) => {
        console.error(`[Alerting] Failed to send notification for UptimeRobot event ${event.id}: ${err.message}`);
      });

      const entry = getOrCreatePlaybookEntry(db, event.failureType);
      const filePath = writePlaybookFile(playbookDir, entry);
      events.push(filePath);
      failureCount++;
      failureCount += await autoRemediateOnRecurrence(db, checkId, entry, event.failureType, playbookDir, events);
    }

    return { checkId, status: 'error', summary: result.error, failureEvents: failureCount, playbookEntries: events, monitors: result.monitors, issues: [] };
  }

  const downMonitors = detectSSLIssues(result.monitors);
  const statusChanges = detectStatusChanges(result.monitors, previousMonitors);

  if (downMonitors.length > 0) {
    for (const monitor of downMonitors) {
      const eventId = uuidv4();
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, 'broken_webhook', 'critical', ?, ?, ?)`,
        [eventId, checkId, `Monitor down: ${monitor.friendlyName}`, `Monitor ${monitor.friendlyName} (${monitor.url}) is down`, JSON.stringify(monitor)]
      );

      await evaluateAndNotify(db, 'broken_webhook', 'critical', `Monitor down: ${monitor.friendlyName}`, `Monitor ${monitor.friendlyName} (${monitor.url}) is down`, new Date().toISOString(), checkId, eventId).catch((err: any) => {
        console.error(`[Alerting] Failed to send notification for down monitor ${eventId}: ${err.message}`);
      });

      const entry = getOrCreatePlaybookEntry(db, 'broken_webhook' as FailureType);
      const filePath = writePlaybookFile(playbookDir, entry);
      events.push(filePath);
      failureCount++;
      failureCount += await autoRemediateOnRecurrence(db, checkId, entry, 'broken_webhook', playbookDir, events);
    }
  }

  if (statusChanges.length > 0) {
    for (const change of statusChanges) {
      const eventId = uuidv4();
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, raw_data) VALUES (?, ?, 'broken_webhook', 'critical', ?, ?, ?)`,
        [eventId, checkId, `Status change: ${change.friendlyName} ${change.previousStatus} -> ${change.status}`, `Monitor ${change.friendlyName} changed status`, JSON.stringify(change)]
      );

      await evaluateAndNotify(db, 'broken_webhook', 'critical', `Status change: ${change.friendlyName} ${change.previousStatus} -> ${change.status}`, `Monitor ${change.friendlyName} changed status`, new Date().toISOString(), checkId, eventId).catch((err: any) => {
        console.error(`[Alerting] Failed to send notification for status change ${eventId}: ${err.message}`);
      });

      const entry = getOrCreatePlaybookEntry(db, 'broken_webhook' as FailureType);
      const filePath = writePlaybookFile(playbookDir, entry);
      events.push(filePath);
      failureCount++;
      failureCount += await autoRemediateOnRecurrence(db, checkId, entry, 'broken_webhook', playbookDir, events);
    }
  }

  const status: 'pass' | 'fail' = failureCount > 0 ? 'fail' : 'pass';
  db.run(
    `INSERT INTO check_results (id, check_id, status, summary, details, raw_data) VALUES (?, ?, ?, ?, ?, ?)`,
    [uuidv4(), checkId, status, `${result.monitors.length} monitors checked, ${downMonitors.length} down, ${statusChanges.length} changes`, JSON.stringify({ down: downMonitors.length, changes: statusChanges.length }), JSON.stringify(result)]
  );

  return {
    checkId,
    status,
    summary: `${result.monitors.length} monitors, ${downMonitors.length} down, ${statusChanges.length} changes`,
    failureEvents: failureCount,
    playbookEntries: events,
    monitors: result.monitors,
    issues: [],
  };
}