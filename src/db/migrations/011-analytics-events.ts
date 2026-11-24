import type { Database } from 'sql.js';

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      team_id TEXT,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      properties TEXT NOT NULL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      forwarded INTEGER NOT NULL DEFAULT 0,
      forward_attempts INTEGER NOT NULL DEFAULT 0,
      forward_error TEXT
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_analytics_events_team ON analytics_events(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event)');
  db.run('CREATE INDEX IF NOT EXISTS idx_analytics_events_received ON analytics_events(received_at DESC)');

  db.run(`
    CREATE TABLE IF NOT EXISTS feedback_responses (
      id TEXT NOT NULL,
      dedup_key TEXT NOT NULL UNIQUE,
      team_id TEXT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('feedback', 'survey')),
      feedback_type TEXT,
      survey_id TEXT,
      score REAL,
      response TEXT NOT NULL,
      event_id TEXT,
      received_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_feedback_responses_team ON feedback_responses(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_feedback_responses_received ON feedback_responses(received_at DESC)');
}

export function down(db: Database): void {
  db.run('DROP INDEX IF EXISTS idx_analytics_events_team');
  db.run('DROP INDEX IF EXISTS idx_analytics_events_event');
  db.run('DROP INDEX IF EXISTS idx_analytics_events_received');
  db.run('DROP INDEX IF EXISTS idx_feedback_responses_team');
  db.run('DROP INDEX IF EXISTS idx_feedback_responses_received');
  db.run('DROP TABLE IF EXISTS analytics_events');
  db.run('DROP TABLE IF EXISTS feedback_responses');
}
