import type { Database } from 'sql.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (result.length === 0 || result[0].values.length === 0) return false;
  return result[0].values.some((row: any) => row[1] === column);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'alert_channels', 'owner_id')) {
    db.run('ALTER TABLE alert_channels ADD COLUMN owner_id TEXT');
  }

  if (hasColumn(db, 'monitored_apps', 'owner_id')) {
    db.run('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
    db.run('CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)');
    return;
  }

  db.run('ALTER TABLE monitored_apps ADD COLUMN owner_id TEXT');
  db.run('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)');
}

export function down(db: Database): void {
  db.run('DROP INDEX IF EXISTS idx_monitored_apps_owner');
  db.run('DROP INDEX IF EXISTS idx_alert_channels_owner');
  try {
    db.run('ALTER TABLE monitored_apps DROP COLUMN owner_id');
  } catch {
    // Older SQLite builds cannot drop columns; the nullable column is harmless.
  }
  try {
    db.run('ALTER TABLE alert_channels DROP COLUMN owner_id');
  } catch {
    // Older SQLite builds cannot drop columns; the nullable column is harmless.
  }
}
