import type { Database } from 'sql.js';

export function up(db: Database): void {
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)'
  );
}

export function down(db: Database): void {
  db.run('DROP INDEX IF EXISTS idx_alert_channels_owner');
}