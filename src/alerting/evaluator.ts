import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { ChannelType, ChannelConfig, sendNotification, NotificationPayload } from './channels';

export interface AlertChannel {
  id: string;
  name: string;
  type: ChannelType;
  config: ChannelConfig;
  enabled: boolean;
}

export interface AlertRule {
  id: string;
  name: string;
  channelId: string;
  failureTypes: string[];
  minSeverity: string;
  enabled: boolean;
}

export interface AlertLogEntry {
  id: string;
  ruleId: string;
  channelId: string;
  failureEventId: string | null;
  failureType: string;
  severity: string;
  channelType: string;
  status: 'sent' | 'failed';
  errorMessage: string | null;
  sentAt: string;
}

function parseConfig(db: Database, channelId: string): ChannelConfig | null {
  const result = db.exec(
    'SELECT type, config FROM alert_channels WHERE id = ?',
    [channelId]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return JSON.parse(result[0].values[0][1] as string) as ChannelConfig;
}

function getChannelType(db: Database, channelId: string): ChannelType | null {
  const result = db.exec(
    'SELECT type FROM alert_channels WHERE id = ?',
    [channelId]
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as ChannelType;
}

function getMatchingRules(db: Database, failureType: string, severity: string): AlertRule[] {
  const severityOrder: Record<string, number> = { critical: 3, warning: 2, info: 1 };
  const eventSeverity = severityOrder[severity] || 1;

  const result = db.exec(
    'SELECT id, name, channel_id, failure_types, min_severity FROM alert_rules WHERE enabled = 1'
  );

  if (result.length === 0) return [];

  return result[0].values
    .map((row: any) => ({
      id: row[0] as string,
      name: row[1] as string,
      channelId: row[2] as string,
      failureTypes: JSON.parse(row[3] as string) as string[],
      minSeverity: row[4] as string,
      enabled: true,
    }))
    .filter((rule) => {
      const ruleMinSeverity = severityOrder[rule.minSeverity] || 1;
      return (
        rule.failureTypes.includes(failureType) &&
        eventSeverity >= ruleMinSeverity
      );
    });
}

function logAlert(
  db: Database,
  ruleId: string,
  channelId: string,
  failureEventId: string | null,
  failureType: string,
  severity: string,
  channelType: string,
  status: 'sent' | 'failed',
  errorMessage: string | null
): void {
  const id = uuidv4();
  db.run(
    `INSERT INTO alert_log (id, rule_id, channel_id, failure_event_id, failure_type, severity, channel_type, status, error_message, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [id, ruleId, channelId, failureEventId, failureType, severity, channelType, status, errorMessage]
  );
}

export async function evaluateAndNotify(
  db: Database,
  failureType: string,
  severity: string,
  title: string,
  description: string,
  detectedAt: string,
  checkId?: string,
  eventId?: string
): Promise<void> {
  const rules = getMatchingRules(db, failureType, severity);
  if (rules.length === 0) return;

  const payload: NotificationPayload = {
    title,
    description,
    failureType,
    severity,
    detectedAt,
    checkId,
    eventId,
  };

  for (const rule of rules) {
    const channelType = getChannelType(db, rule.channelId);
    const config = parseConfig(db, rule.channelId);

    if (!channelType || !config) {
      logAlert(db, rule.id, rule.channelId, eventId || null, failureType, severity, 'unknown', 'failed', 'Channel not found or misconfigured');
      continue;
    }

    try {
      await sendNotification(channelType, config, payload);
      logAlert(db, rule.id, rule.channelId, eventId || null, failureType, severity, channelType, 'sent', null);
    } catch (err: any) {
      logAlert(db, rule.id, rule.channelId, eventId || null, failureType, severity, channelType, 'failed', err.message);
    }
  }
}
