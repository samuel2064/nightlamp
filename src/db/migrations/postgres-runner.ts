import { Pool } from 'pg';

interface PostgresMigrationDefinition {
  id: string;
  up: (pool: Pool) => Promise<void>;
  isApplied: (pool: Pool) => Promise<boolean>;
}

async function tableExists(pool: Pool, table: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = $1",
    [table]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasColumn(pool: Pool, table: string, column: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2",
    [table, column]
  );
  return (result.rowCount ?? 0) > 0;
}

async function hasIndex(pool: Pool, indexName: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = $1",
    [indexName]
  );
  return (result.rowCount ?? 0) > 0;
}

const POSTGRES_MIGRATIONS: PostgresMigrationDefinition[] = [
  {
    id: '008-tenant-isolation',
    up: async (pool: Pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const tables = [
          'checks', 'check_results', 'failure_events', 'playbook_entries',
          'dependencies', 'dependency_updates', 'customers', 'subscriptions',
          'remediation_log', 'remediation_runs', 'remediation_policies',
          'alert_channels', 'alert_rules', 'onboarding_sessions',
          'x_scheduled_posts', 'usage_records', 'webhook_events'
        ];

        for (const table of tables) {
          if (await tableExists(pool, table)) {
            if (!(await hasColumn(pool, table, 'team_id'))) {
              await client.query(`ALTER TABLE ${table} ADD COLUMN team_id TEXT`);
            }
            if (!(await hasIndex(pool, `idx_${table}_team`))) {
              await client.query(`CREATE INDEX IF NOT EXISTS idx_${table}_team ON ${table}(team_id)`);
            }
          }
        }

        if (await tableExists(pool, 'remediation_policies')) {
          if (!(await hasColumn(pool, 'remediation_policies', 'team_id'))) {
            await client.query('ALTER TABLE remediation_policies ADD COLUMN team_id TEXT');
          }
          await client.query(`
            CREATE TABLE IF NOT EXISTS remediation_policies_tenant (
              id TEXT PRIMARY KEY,
              team_id TEXT,
              failure_type TEXT NOT NULL,
              auto_approve INTEGER NOT NULL DEFAULT 0,
              require_dry_run INTEGER NOT NULL DEFAULT 1,
              cooldown_minutes INTEGER NOT NULL DEFAULT 60,
              UNIQUE(team_id, failure_type)
            )
          `);
          await client.query(`
            INSERT INTO remediation_policies_tenant (id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes)
            SELECT id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes
            FROM remediation_policies
            ON CONFLICT (id) DO NOTHING
          `);
          await client.query('DROP TABLE remediation_policies');
          await client.query('ALTER TABLE remediation_policies_tenant RENAME TO remediation_policies');
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    isApplied: async (pool: Pool) => {
      const checks = await hasColumn(pool, 'checks', 'team_id');
      const alerts = await hasColumn(pool, 'alert_rules', 'team_id');
      return checks && alerts;
    },
  },
  {
    id: '010-monitored-apps',
    up: async (pool: Pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (!(await tableExists(pool, 'monitored_apps'))) {
          await client.query(`
            CREATE TABLE monitored_apps (
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
            )
          `);
        }
        if (!(await tableExists(pool, 'health_snapshots'))) {
          await client.query(`
            CREATE TABLE health_snapshots (
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
            )
          `);
        }

        if (!(await hasIndex(pool, 'idx_monitored_apps_team'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_team ON monitored_apps(team_id)');
        }
        if (!(await hasIndex(pool, 'idx_monitored_apps_channel'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_channel ON monitored_apps(alert_channel_id)');
        }
        if (!(await hasIndex(pool, 'idx_health_snapshots_team'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_team ON health_snapshots(team_id)');
        }
        if (!(await hasIndex(pool, 'idx_health_snapshots_app'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_health_snapshots_app ON health_snapshots(app_id, checked_at DESC)');
        }
        if (!(await hasIndex(pool, 'idx_monitored_apps_owner'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    isApplied: async (pool: Pool) => {
      const monitored = await tableExists(pool, 'monitored_apps');
      const health = await tableExists(pool, 'health_snapshots');
      return monitored && health;
    },
  },
  {
    id: '011-analytics-events',
    up: async (pool: Pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (!(await tableExists(pool, 'analytics_events'))) {
          await client.query(`
            CREATE TABLE analytics_events (
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
            )
          `);
        }
        if (!(await tableExists(pool, 'feedback_responses'))) {
          await client.query(`
            CREATE TABLE feedback_responses (
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
            )
          `);
        }

        if (!(await hasIndex(pool, 'idx_analytics_events_team'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_team ON analytics_events(team_id)');
        }
        if (!(await hasIndex(pool, 'idx_analytics_events_event'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_event ON analytics_events(event)');
        }
        if (!(await hasIndex(pool, 'idx_analytics_events_received'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_analytics_events_received ON analytics_events(received_at DESC)');
        }
        if (!(await hasIndex(pool, 'idx_feedback_responses_team'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_team ON feedback_responses(team_id)');
        }
        if (!(await hasIndex(pool, 'idx_feedback_responses_received'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_feedback_responses_received ON feedback_responses(received_at DESC)');
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    isApplied: async (pool: Pool) => {
      const analytics = await tableExists(pool, 'analytics_events');
      const feedback = await tableExists(pool, 'feedback_responses');
      return analytics && feedback;
    },
  },
  {
    id: '012-personal-ownership',
    up: async (pool: Pool) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (await tableExists(pool, 'alert_channels') && !(await hasColumn(pool, 'alert_channels', 'owner_id'))) {
          await client.query('ALTER TABLE alert_channels ADD COLUMN owner_id TEXT');
        }
        if (await tableExists(pool, 'monitored_apps') && !(await hasColumn(pool, 'monitored_apps', 'owner_id'))) {
          await client.query('ALTER TABLE monitored_apps ADD COLUMN owner_id TEXT');
        }

        await client.query(`
          UPDATE alert_channels
          SET owner_id = (
            SELECT teams.owner_id FROM teams WHERE teams.id = alert_channels.team_id
          )
          WHERE owner_id IS NULL
            AND team_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM teams WHERE teams.id = alert_channels.team_id AND teams.owner_id IS NOT NULL)
        `);

        await client.query(`
          UPDATE monitored_apps
          SET owner_id = (
            SELECT teams.owner_id FROM teams WHERE teams.id = monitored_apps.team_id
          )
          WHERE owner_id IS NULL
            AND team_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM teams WHERE teams.id = monitored_apps.team_id AND teams.owner_id IS NOT NULL)
        `);

        if (!(await hasIndex(pool, 'idx_monitored_apps_owner'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_monitored_apps_owner ON monitored_apps(owner_id)');
        }
        if (!(await hasIndex(pool, 'idx_alert_channels_owner'))) {
          await client.query('CREATE INDEX IF NOT EXISTS idx_alert_channels_owner ON alert_channels(owner_id)');
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    isApplied: async (pool: Pool) => {
      const alert = await hasColumn(pool, 'alert_channels', 'owner_id');
      const monitored = await hasColumn(pool, 'monitored_apps', 'owner_id');
      return alert && monitored;
    },
  },
];

async function ledgerContains(pool: Pool, migrationId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT migration_id FROM schema_migrations WHERE migration_id = $1',
    [migrationId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function runPostgresMigrations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
    )
  `);

  for (const migration of POSTGRES_MIGRATIONS) {
    const alreadyApplied = await migration.isApplied(pool);

    if (!alreadyApplied) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await migration.up(pool);
        await client.query('INSERT INTO schema_migrations (migration_id) VALUES ($1)', [migration.id]);
        await client.query('COMMIT');
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The failed transaction is already rolled back by PostgreSQL.
        }
        throw error;
      } finally {
        client.release();
      }
      continue;
    }

    if (!(await ledgerContains(pool, migration.id))) {
      await pool.query('INSERT OR IGNORE INTO schema_migrations (migration_id) VALUES ($1)', [migration.id]);
    }
  }
}