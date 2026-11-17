import { Database } from 'sql.js';

export function isChannelAttachedToApp(db: Database, channelId: string): boolean {
  const result = db.exec(
    'SELECT id FROM monitored_apps WHERE alert_channel_id = ? LIMIT 1',
    [channelId],
  );
  return result.length > 0 && result[0].values.length > 0;
}
