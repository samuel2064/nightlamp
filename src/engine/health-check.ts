import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';
import { SentryConfig, SentryIssue, pollSentry, detectSpikes, detectNewPatterns } from '../connectors';
import { UptimeRobotConfig, UptimeRobotMonitor, pollUptimeRobot, detectStatusChanges, detectSSLIssues } from '../connectors';
import { classifyFailure, FailureType } from '../classifier';
import { getOrCreatePlaybookEntry, writePlaybookFile } from '../playbook';
import { runRemediation } from '../remediation/engine';

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
  const checkId = uuidv4();
  const events: string[] = [];
  let failureCount = 0;

  db.run(
    `INSERT INTO checks (id, source, name, config, enabled) VALUES (?, 'sentry', 'Sentry Error Monitor', ?, 1)`,
    [checkId, JSON.stringify(config)]
  );

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
  const checkId = uuidv4();
  const events: string[] = [];
  let failureCount = 0;

  db.run(
    `INSERT INTO checks (id, source, name, config, enabled) VALUES (?, 'uptimerobot', 'UptimeRobot Monitor', ?, 1)`,
    [checkId, JSON.stringify(config)]
  );

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