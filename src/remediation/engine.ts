import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';
import { FailureType } from '../classifier';
import { PlaybookEntry } from '../playbook';
import { remediateWebhookRestart } from './scripts/webhook-restart';
import { remediateTokenRefresh } from './scripts/token-refresh';
import { remediateSchemaMigrate } from './scripts/schema-migrate';
import { remediateRateLimitBackoff } from './scripts/rate-limit-backoff';

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