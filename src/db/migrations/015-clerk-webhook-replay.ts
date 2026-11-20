import type { Database } from 'sql.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

export function up(db: Database): void {
  // Create clerk_webhook_events table for durable replay protection
  const hasTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='clerk_webhook_events'");
  if (hasTable.length === 0 || hasTable[0].values.length === 0) {
    db.run(`
      CREATE TABLE clerk_webhook_events (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT (datetime('now')),
        team_id TEXT
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_received ON clerk_webhook_events(received_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_team ON clerk_webhook_events(team_id)`);
  } else if (!hasColumn(db, 'clerk_webhook_events', 'team_id')) {
    db.run(`ALTER TABLE clerk_webhook_events ADD COLUMN team_id TEXT`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_team ON clerk_webhook_events(team_id)`);
  }
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF NOT EXISTS idx_clerk_webhook_events_received`);
  db.run(`DROP INDEX IF NOT EXISTS idx_clerk_webhook_events_team`);
  db.run(`DROP TABLE IF EXISTS clerk_webhook_events`);
}