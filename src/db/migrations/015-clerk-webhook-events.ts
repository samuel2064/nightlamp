import type { Database } from 'sql.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS clerk_webhook_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      livemode INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'processed', 'failed', 'skipped')),
      error TEXT,
      payload TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      processed_at TEXT
    );
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_type ON clerk_webhook_events(event_type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_received ON clerk_webhook_events(received_at DESC)');
}

export function down(db: Database): void {
  db.run('DROP INDEX IF EXISTS idx_clerk_webhook_events_type');
  db.run('DROP INDEX IF EXISTS idx_clerk_webhook_events_received');
  if (hasColumn(db, 'clerk_webhook_events', 'id')) {
    db.run('DROP TABLE clerk_webhook_events');
  }
}