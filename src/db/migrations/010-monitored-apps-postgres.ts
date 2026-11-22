import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // monitored_apps
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitored_apps (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        url TEXT NOT NULL,
        platform TEXT NOT NULL CHECK(platform IN ('vercel', 'railway', 'heroku', 'aws', 'gcp', 'azure', 'custom')),
        check_type TEXT NOT NULL CHECK(check_type IN ('http', 'tcp', 'keyword')),
        check_target TEXT NOT NULL,
        check_interval_sec INTEGER NOT NULL DEFAULT 60 CHECK(check_interval_sec BETWEEN 10 AND 86400),
        check_timeout_sec INTEGER NOT NULL DEFAULT 10 CHECK(check_timeout_sec BETWEEN 1 AND 30),
        keyword TEXT,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        alert_channel_id TEXT NOT NULL,
        owner_id TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        FOREIGN KEY (team_id) REFERENCES teams(id),
        FOREIGN KEY (alert_channel_id) REFERENCES alert_channels(id)
      );
    `);

    // health_snapshots
    await client.query(`
      CREATE TABLE IF NOT EXISTS health_snapshots (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        team_id TEXT,
        status TEXT NOT NULL CHECK(status IN ('pass', 'fail')),
        status_code INTEGER,
        latency_ms REAL NOT NULL,
        error_type TEXT,
        error_detail TEXT,
        checked_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        FOREIGN KEY (app_id) REFERENCES monitored_apps(id) ON DELETE CASCADE,
        FOREIGN KEY (team_id) REFERENCES teams(id)
      );
    `);

    // Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_team ON monitored_apps(team_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_channel ON monitored_apps(alert_channel_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_team ON health_snapshots(team_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_app ON health_snapshots(app_id, checked_at DESC)');

    // Record migration
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    await client.query('INSERT INTO schema_migrations (migration_id) VALUES ($1) ON CONFLICT DO NOTHING', ['010-monitored-apps']);

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

    await client.query('DROP INDEX IF EXISTS idx_health_snapshots_app');
    await client.query('DROP INDEX IF EXISTS idx_health_snapshots_team');
    await client.query('DROP INDEX IF EXISTS idx_monitored_apps_owner');
    await client.query('DROP INDEX IF EXISTS idx_monitored_apps_channel');
    await client.query('DROP INDEX IF EXISTS idx_monitored_apps_team');
    await client.query('DROP TABLE IF EXISTS health_snapshots');
    await client.query('DROP TABLE IF EXISTS monitored_apps');
    await client.query('DELETE FROM schema_migrations WHERE migration_id = $1', ['010-monitored-apps']);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}