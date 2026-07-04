import type { Database } from 'sql.js'

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS alert_channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('slack', 'email', 'pagerduty')),
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      failure_types TEXT NOT NULL,
      min_severity TEXT NOT NULL DEFAULT 'info' CHECK(min_severity IN ('critical', 'warning', 'info')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (channel_id) REFERENCES alert_channels(id)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS alert_log (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      failure_event_id TEXT,
      failure_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      channel_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
      error_message TEXT,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
}

export function down(db: Database): void {
  db.run('DROP TABLE IF EXISTS alert_log')
  db.run('DROP TABLE IF EXISTS alert_rules')
  db.run('DROP TABLE IF EXISTS alert_channels')
}
