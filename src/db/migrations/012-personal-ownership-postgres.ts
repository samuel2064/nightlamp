import { Pool } from 'pg';

export async function up(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add owner_id column to alert_channels if not exists
    const alertChannelsHasOwner = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'alert_channels' AND column_name = 'owner_id'
    `);
    if (alertChannelsHasOwner.rows.length === 0) {
      await client.query('ALTER TABLE alert_channels ADD COLUMN owner_id TEXT');
    }

    // Add owner_id column to monitored_apps if not exists
    const monitoredAppsHasOwner = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'monitored_apps' AND column_name = 'owner_id'
    `);
    if (monitoredAppsHasOwner.rows.length === 0) {
      await client.query('ALTER TABLE monitored_apps ADD COLUMN owner_id TEXT');
    }

    // Backfill owner_id for alert_channels
    await client.query(`
      UPDATE alert_channels
      SET owner_id = (
        SELECT teams.owner_id FROM teams WHERE teams.id = alert_channels.team_id
      )
      WHERE owner_id IS NULL
        AND team_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM teams WHERE teams.id = alert_channels.team_id AND teams.owner_id IS NOT NULL)
    `);

    // Backfill owner_id for monitored_apps
    await client.query(`
      UPDATE monitored_apps
      SET owner_id = (
        SELECT teams.owner_id FROM teams WHERE teams.id = monitored_apps.team_id
      )
      WHERE owner_id IS NULL
        AND team_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM teams WHERE teams.id = monitored_apps.team_id AND teams.owner_id IS NOT NULL)
    `);

    // Indexes
    await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)');

    // Record migration
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        migration_id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
      );
    `);
    await client.query('INSERT INTO schema_migrations (migration_id) VALUES ($1) ON CONFLICT DO NOTHING', ['012-personal-ownership']);

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

    await client.query('DROP INDEX IF EXISTS idx_monitored_apps_owner');
    await client.query('DROP INDEX IF EXISTS idx_alert_channels_owner');
    await client.query('ALTER TABLE monitored_apps DROP COLUMN IF EXISTS owner_id');
    await client.query('ALTER TABLE alert_channels DROP COLUMN IF EXISTS owner_id');
    await client.query('DELETE FROM schema_migrations WHERE migration_id = $1', ['012-personal-ownership']);

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}