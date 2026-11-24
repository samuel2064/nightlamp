import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // analytics_events
    await client.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id TEXT NOT NULL,
        dedup_key TEXT NOT NULL UNIQUE,
        team_id TEXT,
        user_id TEXT NOT NULL,
        event TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        properties TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        forwarded INTEGER NOT NULL DEFAULT 0,
        forward_attempts INTEGER NOT NULL DEFAULT 0,
        forward_error TEXT
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_team ON analytics_events(team_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_received ON analytics_events(received_at DESC)');

    // feedback_responses
    await client.query(`
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
        received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_team ON feedback_responses(team_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_received ON feedback_responses(received_at DESC)');

    // Record migration
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    await client.query('INSERT INTO schema_migrations (migration_id) VALUES ($1) ON CONFLICT DO NOTHING', ['011-analytics-events']);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function down(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query('DROP INDEX IF EXISTS idx_analytics_events_team');
    await client.query('DROP INDEX IF EXISTS idx_analytics_events_event');
    await client.query('DROP INDEX IF EXISTS idx_analytics_events_received');
    await client.query('DROP INDEX IF EXISTS idx_feedback_responses_team');
    await client.query('DROP INDEX IF EXISTS idx_feedback_responses_received');
    await client.query('DROP TABLE IF EXISTS analytics_events');
    await client.query('DROP TABLE IF EXISTS feedback_responses');
    await client.query('DELETE FROM schema_migrations WHERE migration_id = $1', ['011-analytics-events']);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}