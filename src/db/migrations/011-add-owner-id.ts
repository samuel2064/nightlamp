import type { Database } from 'sql.js';

export function up(db: Database): void {
  if (!tableExists(db, 'alert_channels')) {
    console.log('[Migration 011] alert_channels table does not exist, skipping');
    return;
  }

  if (hasColumn(db, 'alert_channels', 'owner_id')) {
    console.log('[Migration 011] owner_id column already exists, skipping');
    return;
  }

  db.run(`ALTER TABLE alert_channels ADD COLUMN owner_id TEXT`);

  // Backfill owner_id: set to team_id if team_id is determinable, otherwise null
  db.run(
    `UPDATE alert_channels SET owner_id = team_id WHERE team_id IS NOT NULL`
  );

  db.run(`CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)`);
  console.log('[Migration 011] owner_id column added to alert_channels and backfilled');
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_alert_channels_owner`);
  db.run(`ALTER TABLE alert_channels DROP COLUMN owner_id`);
}

function tableExists(db: Database, table: string): boolean {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return result.length > 0 && result[0].values.length > 0;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}