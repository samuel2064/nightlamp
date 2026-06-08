import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';
import { FailureType } from '../classifier';
import { PlaybookEntry } from '../playbook';
import { remediateWebhookRestart } from './scripts/webhook-restart';
import { remediateTokenRefresh } from './scripts/token-refresh';
import { remediateSchemaMigrate } from './scripts/schema-migrate';
import { remediateRateLimitBackoff } from './scripts/rate-limit-backoff';
import { listActions } from './actions/registry';
import { getAction, registerAction } from './actions/registry';
import { handleRetryWebhook } from './actions/retry-webhook';
import { handleRateLimitBackoff } from './actions/rate-limit-backoff';
import { handleClearCache } from './actions/clear-cache';
import { handleNpmUpdate } from './actions/npm-update';
import { handleRotateToken } from './actions/rotate-token';
import { handleRestartService } from './actions/restart-service';

export interface RemediationLogEntry {
  id: string;
  playbookEntryId: string;
  failureType: string;
  script: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  output: string;
  executedAt: string;
}

export type RemediationStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface RemediationResult {
  logId: string;
  status: RemediationStatus;
  output: string;
}

const SCRIPT_MAP: Record<FailureType, string> = {
  broken_webhook: 'webhook-restart',
  expired_token: 'token-refresh',
  schema_drift: 'schema-migrate',
  rate_limit_shift: 'rate-limit-backoff',
  error_spike: 'webhook-restart',
  new_error_pattern: 'webhook-restart',
  remediation_triggered: 'webhook-restart',
};

export function getScriptForFailureType(failureType: FailureType): string {
  return SCRIPT_MAP[failureType] || 'webhook-restart';
}

export async function runRemediation(
  db: Database,
  playbookEntry: PlaybookEntry,
  context?: { webhookUrl?: string; tokenEndpoint?: string; clientId?: string; clientSecret?: string; apiEndpoint?: string; newSchemaVersion?: string; currentIntervalSec?: number },
): Promise<RemediationResult> {
  const logId = uuidv4();
  const script = getScriptForFailureType(playbookEntry.failureType);

  db.run(
    `INSERT INTO remediation_log (id, playbook_entry_id, failure_type, script, status, output) VALUES (?, ?, ?, ?, 'running', '')`,
    [logId, playbookEntry.id, playbookEntry.failureType, script],
  );

  try {
    let result: { success: boolean; output: string };

    switch (playbookEntry.failureType) {
      case 'broken_webhook':
        result = await remediateWebhookRestart(context?.webhookUrl);
        break;
      case 'expired_token':
        result = await remediateTokenRefresh(context?.tokenEndpoint, context?.clientId, context?.clientSecret);
        break;
      case 'schema_drift':
        result = await remediateSchemaMigrate(context?.apiEndpoint, context?.newSchemaVersion);
        break;
      case 'rate_limit_shift':
        result = await remediateRateLimitBackoff(context?.currentIntervalSec);
        break;
      case 'error_spike':
        result = await remediateWebhookRestart(context?.webhookUrl);
        break;
      case 'new_error_pattern':
        result = await remediateWebhookRestart(context?.webhookUrl);
        break;
      default:
        result = { success: false, output: `No remediation script available for failure type: ${playbookEntry.failureType}` };
    }

    const status: RemediationStatus = result.success ? 'success' : 'failed';
    db.run(
      `UPDATE remediation_log SET status = ?, output = ?, executed_at = datetime('now') WHERE id = ?`,
      [status, result.output, logId],
    );

    return { logId, status, output: result.output };
  } catch (err: any) {
    const errorOutput = `Remediation engine error: ${err.message}`;
    db.run(
      `UPDATE remediation_log SET status = 'failed', output = ?, executed_at = datetime('now') WHERE id = ?`,
      [errorOutput, logId],
    );
    return { logId, status: 'failed', output: errorOutput };
  }
}

export function getRemediationLogs(
  db: Database,
  limit: number = 50,
  offset: number = 0,
  failureType?: string,
): { logs: RemediationLogEntry[]; count: number } {
  let sql = 'SELECT id, playbook_entry_id, failure_type, script, status, output, executed_at FROM remediation_log WHERE 1=1';
  const params: any[] = [];

  if (failureType) {
    sql += ' AND failure_type = ?';
    params.push(failureType);
  }

  sql += ' ORDER BY executed_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const countSql = failureType
    ? 'SELECT COUNT(*) FROM remediation_log WHERE failure_type = ?'
    : 'SELECT COUNT(*) FROM remediation_log';
  const countParams = failureType ? [failureType] : [];
  const countResult = db.exec(countSql, countParams);
  const totalCount = countResult.length > 0 && countResult[0].values.length > 0
    ? (countResult[0].values[0][0] as number) : 0;

  const result = db.exec(sql, params);
  const logs = result.length > 0 ? result[0].values.map((row: any) => ({
    id: row[0] as string,
    playbookEntryId: row[1] as string,
    failureType: row[2] as string,
    script: row[3] as string,
    status: row[4] as RemediationStatus,
    output: row[5] as string,
    executedAt: row[6] as string,
  })) : [];

  return { logs, count: totalCount };
}

let dbInstance: Database | null = null;
export function setDb(db: Database) { dbInstance = db; }
function getDb(): Database {
  if (!dbInstance) throw new Error('Database not initialized');
  return dbInstance;
}

export function listRuns(params: { status?: string; playbook_entry_id?: string; limit?: number; offset?: number } = {}): any {
  const db = getDb();
  let sql = 'SELECT id, playbook_entry_id, action_name, status, initiated_by, approved_by, output, error, started_at, completed_at, created_at FROM remediation_runs WHERE 1=1';
  const q: any[] = [];
  if (params.status) { sql += ' AND status = ?'; q.push(params.status); }
  if (params.playbook_entry_id) { sql += ' AND playbook_entry_id = ?'; q.push(params.playbook_entry_id); }
  sql += ' ORDER BY created_at DESC';
  if (params.limit) { sql += ' LIMIT ?'; q.push(params.limit); }
  if (params.offset) { sql += ' OFFSET ?'; q.push(params.offset); }
  const res = db.exec(sql, q);
  return res.length ? res[0].values.map(r => ({ id: r[0], playbook_entry_id: r[1], action_name: r[2], status: r[3], initiated_by: r[4], approved_by: r[5], output: r[6], error: r[7], started_at: r[8], completed_at: r[9], created_at: r[10] })) : [];
}

export async function approveRun(id: string): Promise<any> {
  const db = getDb();
  db.run(`UPDATE remediation_runs SET status = 'running', started_at = datetime('now') WHERE id = ?`, [id]);
  const run = db.exec(`SELECT * FROM remediation_runs WHERE id = ?`, [id]);
  if (!run.length || !run[0].values.length) throw new Error('Run not found');
  const r = run[0].values[0];
  const actionName = r[2] as string;
  const handler = getAction(actionName);
  if (!handler) throw new Error(`No handler for action: ${actionName}`);
  const failure = { failure_type: r[2] as string, affected_resource: r[1] as string, description: r[6] as string };
  const result = await handler(failure);
  const status = result.success ? 'success' : 'failed';
  db.run(`UPDATE remediation_runs SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?`, [status, result.output, id]);
  return { id, status, output: result.output };
}

export function rejectRun(id: string): any {
  const db = getDb();
  db.run(`UPDATE remediation_runs SET status = 'rejected', completed_at = datetime('now') WHERE id = ?`, [id]);
  return { id, status: 'rejected' };
}

export async function retryRun(id: string): Promise<any> {
  const db = getDb();
  const run = db.exec(`SELECT * FROM remediation_runs WHERE id = ?`, [id]);
  if (!run.length || !run[0].values.length) throw new Error('Run not found');
  const r = run[0].values[0];
  const actionName = r[2] as string;
  const handler = getAction(actionName);
  if (!handler) throw new Error(`No handler for action: ${actionName}`);
  db.run(`UPDATE remediation_runs SET status = 'running', started_at = datetime('now') WHERE id = ?`, [id]);
  const failure = { failure_type: actionName, affected_resource: r[1] as string, description: r[6] as string };
  const result = await handler(failure);
  const status = result.success ? 'success' : 'failed';
  db.run(`UPDATE remediation_runs SET status = ?, output = ?, completed_at = datetime('now') WHERE id = ?`, [status, result.output, id]);
  return { id, status, output: result.output };
}

export function listPolicies(): any {
  const db = getDb();
  const res = db.exec(`SELECT id, failure_type, auto_approve, require_dry_run, cooldown_minutes FROM remediation_policies`);
  return res.length ? res[0].values.map(r => ({ id: r[0], failure_type: r[1], auto_approve: r[2], require_dry_run: r[3], cooldown_minutes: r[4] })) : [];
}

export function updatePolicy(id: string, data: { auto_approve?: boolean; require_dry_run?: boolean; cooldown_minutes?: number }): any {
  const db = getDb();
  const updates: string[] = [];
  const params: any[] = [];
  if (data.auto_approve !== undefined) { updates.push('auto_approve = ?'); params.push(data.auto_approve ? 1 : 0); }
  if (data.require_dry_run !== undefined) { updates.push('require_dry_run = ?'); params.push(data.require_dry_run ? 1 : 0); }
  if (data.cooldown_minutes !== undefined) { updates.push('cooldown_minutes = ?'); params.push(data.cooldown_minutes); }
  if (!updates.length) throw new Error('No fields to update');
  params.push(id);
  db.run(`UPDATE remediation_policies SET ${updates.join(', ')} WHERE id = ?`, params);
  return listPolicies().find(p => p.id === id);
}

export function initEngine(): void {
  registerAction('retry-webhook', 'broken_webhook', handleRetryWebhook);
  registerAction('retry-webhook', 'error_spike', handleRetryWebhook);
  registerAction('retry-webhook', 'new_error_pattern', handleRetryWebhook);
  registerAction('retry-webhook', 'remediation_triggered', handleRetryWebhook);
  registerAction('rate-limit-backoff', 'rate_limit_shift', handleRateLimitBackoff);
  registerAction('clear-cache', 'error_spike', handleClearCache);
  registerAction('npm-update', 'dependency.outdated', handleNpmUpdate);
  registerAction('rotate-token', 'expired_token', handleRotateToken);
  registerAction('restart-service', 'broken_webhook', handleRestartService);
}