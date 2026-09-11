import type { Database } from 'sql.js'

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS notification_rate_limits (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      max_per_minute INTEGER NOT NULL DEFAULT 10,
      max_per_hour INTEGER NOT NULL DEFAULT 100,
      window_start TEXT NOT NULL,
      current_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_deduplication (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      suppress_until TEXT,
      suppression_count INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
    );
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dedup_fingerprint ON notification_deduplication(channel_id, fingerprint)
  `)

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_rate_limit_channel ON notification_rate_limits(channel_id, window_start)
  `)
}

export function down(db: Database): void {
  db.run('DROP TABLE IF EXISTS notification_deduplication')
  db.run('DROP TABLE IF EXISTS notification_rate_limits')
}
