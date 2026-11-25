import { PoolClient } from 'pg';

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    [table]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasColumn(client: PoolClient, table: string, column: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [table, column]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasIndex(client: PoolClient, indexName: string): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = $1",
    [indexName]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function up(client: PoolClient): Promise<void> {
  // clerk_webhook_events table (for databases that already ran 009-postgres-setup before this table was added)
  if (!(await tableExists(client, 'clerk_webhook_events'))) {
    await client.query(`
      CREATE TABLE clerk_webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        processed_at TEXT,
        status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received', 'processed', 'failed', 'skipped')),
        error TEXT
      )
    `);
  }

  // Add team_id column if it doesn't exist (for databases that already ran 008-tenant-isolation before this table was added)
  if (await tableExists(client, 'clerk_webhook_events') && !(await hasColumn(client, 'clerk_webhook_events', 'team_id'))) {
    await client.query('ALTER TABLE clerk_webhook_events ADD COLUMN team_id TEXT');
  }

  // Add indexes if they don't exist
  if (!(await hasIndex(client, 'idx_clerk_webhook_events_type'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_type ON clerk_webhook_events(event_type)');
  }
  if (!(await hasIndex(client, 'idx_clerk_webhook_events_received'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_received ON clerk_webhook_events(received_at DESC)');
  }
  if (!(await hasIndex(client, 'idx_clerk_webhook_events_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_team ON clerk_webhook_events(team_id)');
  }
}