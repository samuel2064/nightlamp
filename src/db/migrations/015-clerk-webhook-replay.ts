import type { Database } from 'sql.js';

export function up(db: Database): void {
  // Create clerk_webhook_events table for durable replay protection
  const hasTable = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='clerk_webhook_events'");
  if (hasTable.length === 0 || hasTable[0].values.length === 0) {
    db.run(`
      CREATE TABLE clerk_webhook_events (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_received ON clerk_webhook_events(received_at)`);
  }
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_clerk_webhook_events_received`);
  db.run(`DROP TABLE IF EXISTS clerk_webhook_events`);
}