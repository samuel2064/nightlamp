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
  // clerk_webhook_events table with SQLite-effective schema (id, received_at, team_id)
  // The orphaned 015-clerk-webhook-events.ts (event_type, livemode, status, error, payload, processed_at) has no call site and is not the effective table
  if (!(await tableExists(client, 'clerk_webhook_events'))) {
    await client.query(`
      CREATE TABLE clerk_webhook_events (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
        team_id TEXT
      )
    `);
  }

  // Add team_id column if it doesn't exist (for databases that already ran 009-postgres-setup before this table was added)
  if (await tableExists(client, 'clerk_webhook_events') && !(await hasColumn(client, 'clerk_webhook_events', 'team_id'))) {
    await client.query('ALTER TABLE clerk_webhook_events ADD COLUMN team_id TEXT');
  }

  // Add indexes for clerk_webhook_events matching SQLite names
  if (!(await hasIndex(client, 'idx_clerk_webhook_events_received'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_received ON clerk_webhook_events(received_at DESC)');
  }
  if (!(await hasIndex(client, 'idx_clerk_webhook_events_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_team ON clerk_webhook_events(team_id)');
  }

  // Add team_id column and indexes to the five tables that 008-tenant-isolation missed
  // leads
  if (await tableExists(client, 'leads') && !(await hasColumn(client, 'leads', 'team_id'))) {
    await client.query('ALTER TABLE leads ADD COLUMN team_id TEXT');
  }
  if (await tableExists(client, 'leads') && !(await hasIndex(client, 'idx_leads_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_leads_team ON leads(team_id)');
  }

  // perf_runs
  if (await tableExists(client, 'perf_runs') && !(await hasColumn(client, 'perf_runs', 'team_id'))) {
    await client.query('ALTER TABLE perf_runs ADD COLUMN team_id TEXT');
  }
  if (await tableExists(client, 'perf_runs') && !(await hasIndex(client, 'idx_perf_runs_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_perf_runs_team ON perf_runs(team_id)');
  }

  // perf_regressions
  if (await tableExists(client, 'perf_regressions') && !(await hasColumn(client, 'perf_regressions', 'team_id'))) {
    await client.query('ALTER TABLE perf_regressions ADD COLUMN team_id TEXT');
  }
  if (await tableExists(client, 'perf_regressions') && !(await hasIndex(client, 'idx_perf_regressions_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_perf_regressions_team ON perf_regressions(team_id)');
  }

  // perf_diagnoses
  if (await tableExists(client, 'perf_diagnoses') && !(await hasColumn(client, 'perf_diagnoses', 'team_id'))) {
    await client.query('ALTER TABLE perf_diagnoses ADD COLUMN team_id TEXT');
  }
  if (await tableExists(client, 'perf_diagnoses') && !(await hasIndex(client, 'idx_perf_diagnoses_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_perf_diagnoses_team ON perf_diagnoses(team_id)');
  }

  // playbook_executions
  if (await tableExists(client, 'playbook_executions') && !(await hasColumn(client, 'playbook_executions', 'team_id'))) {
    await client.query('ALTER TABLE playbook_executions ADD COLUMN team_id TEXT');
  }
  if (await tableExists(client, 'playbook_executions') && !(await hasIndex(client, 'idx_playbook_executions_team'))) {
    await client.query('CREATE INDEX IF NOT EXISTS idx_playbook_executions_team ON playbook_executions(team_id)');
  }
}