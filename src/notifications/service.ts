import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { ChannelType, ChannelConfig, sendNotification, NotificationPayload } from '../alerting/channels';

export const SEVERITY_ORDER: Record<string, number> = { critical: 3, warning: 2, info: 1 };

export interface DeliveryAttempt {
  id: string;
  notificationId: string;
  attempt: number;
  status: string;
  errorMessage: string | null;
  attemptedAt: string;
}

export interface NotificationRequest {
  channelId: string;
  channelType: ChannelType;
  config: ChannelConfig;
  payload: NotificationPayload;
}

export function getChannelType(db: Database, channelId: string): ChannelType | null {
  const result = db.exec(
    'SELECT type FROM alert_channels WHERE id = ?',
    [channelId]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as ChannelType;
}

export function getChannelConfig(db: Database, channelId: string): ChannelConfig | null {
  const result = db.exec(
    'SELECT config FROM alert_channels WHERE id = ?',
    [channelId]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return JSON.parse(result[0].values[0][0] as string) as ChannelConfig;
}

export function logDelivery(
  db: Database,
  ruleId: string | null,
  channelId: string,
  failureEventId: string | null,
  failureType: string,
  severity: string,
  channelType: string,
  status: string,
  errorMessage: string | null
): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO alert_log (id, rule_id, channel_id, failure_event_id, failure_type, severity, channel_type, status, error_message, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [id, ruleId, channelId, failureEventId, failureType, severity, channelType, status, errorMessage]
  );
  return id;
}

export function markDelivered(db: Database, logId: string): void {
  db.run(
    `UPDATE alert_log SET status = 'delivered', sent_at = datetime('now') WHERE id = ?`,
    [logId]
  );
}

export interface RateLimitConfig {
  maxPerMinute: number;
  maxPerHour: number;
}

export function getRateLimitConfig(db: Database, channelId: string): RateLimitConfig {
  const result = db.exec(
    'SELECT max_per_minute, max_per_hour FROM notification_rate_limits WHERE channel_id = ?',
    [channelId]
  );
  if (result.length === 0 || result[0].values.length === 0) {
    return { maxPerMinute: 10, maxPerHour: 100 };
  }
  return {
    maxPerMinute: result[0].values[0][0] as number,
    maxPerHour: result[0].values[0][1] as number,
  };
}

export function setRateLimitConfig(db: Database, channelId: string, config: RateLimitConfig): void {
  db.run('DELETE FROM notification_rate_limits WHERE channel_id = ?', [channelId]);
  db.run(
    `INSERT INTO notification_rate_limits (id, channel_id, max_per_minute, max_per_hour, window_start, current_count)
     VALUES (?, ?, ?, ?, datetime('now'), 0)`,
    [uuidv4(), channelId, config.maxPerMinute, config.maxPerHour]
  );
}

export function checkRateLimit(db: Database, channelId: string): boolean {
  const config = getRateLimitConfig(db, channelId);

  const minuteResult = db.exec(
    `SELECT COUNT(*) FROM alert_log
     WHERE channel_id = ? AND status IN ('sent', 'delivered')
     AND sent_at >= datetime('now', '-1 minute')`,
    [channelId]
  );
  const minuteCount: number = minuteResult.length > 0 ? minuteResult[0].values[0][0] as number : 0;

  const hourResult = db.exec(
    `SELECT COUNT(*) FROM alert_log
     WHERE channel_id = ? AND status IN ('sent', 'delivered')
     AND sent_at >= datetime('now', '-1 hour')`,
    [channelId]
  );
  const hourCount: number = hourResult.length > 0 ? hourResult[0].values[0][0] as number : 0;

  return minuteCount < config.maxPerMinute && hourCount < config.maxPerHour;
}

export function getDedupFingerprint(payload: NotificationPayload): string {
  return `${payload.failureType}:${payload.severity}:${payload.checkId || ''}:${payload.title}`;
}

export function checkDedup(db: Database, channelId: string, fingerprint: string): { suppressed: boolean; suppressUntil: string | null } {
  const result = db.exec(
    `SELECT id, suppress_until, suppression_count FROM notification_deduplication
     WHERE channel_id = ? AND fingerprint = ?`,
    [channelId, fingerprint]
  );

  if (result.length === 0 || result[0].values.length === 0) {
    const id = uuidv4();
    db.run(
      `INSERT INTO notification_deduplication (id, channel_id, fingerprint, first_seen_at, last_seen_at, suppression_count)
       VALUES (?, ?, ?, datetime('now'), datetime('now'), 0)`,
      [id, channelId, fingerprint]
    );
    return { suppressed: false, suppressUntil: null };
  }

  const row = result[0].values[0];
  const dedupId = row[0] as string;
  const suppressUntil = row[1] as string | null;

  db.run(
    `UPDATE notification_deduplication SET last_seen_at = datetime('now'), suppression_count = suppression_count + 1 WHERE id = ?`,
    [dedupId]
  );

  if (suppressUntil) {
    const suppressDate = new Date(suppressUntil);
    if (!isNaN(suppressDate.getTime()) && suppressDate > new Date()) {
      return { suppressed: true, suppressUntil };
    }
  }

  return { suppressed: false, suppressUntil: null };
}

export function setDedupSuppression(db: Database, channelId: string, fingerprint: string, durationMinutes: number): void {
  db.run(
    `UPDATE notification_deduplication
     SET suppress_until = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+${durationMinutes} minutes')
     WHERE channel_id = ? AND fingerprint = ?`,
    [channelId, fingerprint]
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function deliverWithRetry(
  db: Database,
  channelType: ChannelType,
  channelConfig: ChannelConfig,
  payload: NotificationPayload,
  maxRetries: number = 3
): Promise<{ success: boolean; status: string; errorMessage: string | null; attempts: number }> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sendNotification(channelType, channelConfig, payload);
      return { success: true, status: 'sent', errorMessage: null, attempts: attempt };
    } catch (err: any) {
      lastError = err.message;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
      }
    }
  }

  return { success: false, status: 'failed', errorMessage: lastError, attempts: maxRetries };
}

export async function processNotification(
  db: Database,
  channelId: string,
  channelType: ChannelType,
  channelConfig: ChannelConfig,
  payload: NotificationPayload,
  dedupMinutes: number = 5
): Promise<{ sent: boolean; logId: string | null; skipped: string | null }> {
  const fingerprint = getDedupFingerprint(payload);
  const dedupResult = checkDedup(db, channelId, fingerprint);

  if (dedupResult.suppressed) {
    const logId = logDelivery(db, null, channelId, payload.eventId || null, payload.failureType, payload.severity, channelType, 'skipped', `Deduplicated: suppressed until ${dedupResult.suppressUntil}`);
    return { sent: false, logId, skipped: 'deduplicated' };
  }

  if (!checkRateLimit(db, channelId)) {
    const logId = logDelivery(db, null, channelId, payload.eventId || null, payload.failureType, payload.severity, channelType, 'skipped', 'Rate limit exceeded');
    return { sent: false, logId, skipped: 'rate_limited' };
  }

  const logId = logDelivery(db, null, channelId, payload.eventId || null, payload.failureType, payload.severity, channelType, 'pending', null);

  const result = await deliverWithRetry(db, channelType, channelConfig, payload);

  if (result.success) {
    db.run(
      `UPDATE alert_log SET status = 'sent', sent_at = datetime('now') WHERE id = ?`,
      [logId]
    );
  } else {
    db.run(
      `UPDATE alert_log SET status = 'failed', error_message = ? WHERE id = ?`,
      [result.errorMessage, logId]
    );
  }

  if (result.success) {
    setDedupSuppression(db, channelId, fingerprint, dedupMinutes);
  }

  return { sent: result.success, logId, skipped: null };
}

export async function sendDirectNotification(
  db: Database,
  channelId: string,
  channelType: ChannelType,
  channelConfig: ChannelConfig,
  payload: NotificationPayload
): Promise<{ success: boolean; logId: string }> {
  const logId = logDelivery(db, null, channelId, payload.eventId || null, payload.failureType, payload.severity, channelType, 'pending', null);

  const result = await deliverWithRetry(db, channelType, channelConfig, payload);

  if (result.success) {
    db.run(
      `UPDATE alert_log SET status = 'sent', sent_at = datetime('now') WHERE id = ?`,
      [logId]
    );
  } else {
    db.run(
      `UPDATE alert_log SET status = 'failed', error_message = ? WHERE id = ?`,
      [result.errorMessage, logId]
    );
  }

  return { success: result.success, logId };
}
