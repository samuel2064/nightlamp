import { createDatabase, saveDatabase, getDatabaseConfig } from '../db/schema';
import { bootId, getBootId, shouldWarnAboutEphemeralStorage, getPersistentMountPath, getExpectedDatabasePath, DEFAULT_PERSISTENT_MOUNT_PATH } from '../db/connection';
import { Database } from 'sql.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import assert from 'assert';

const SQLITE_MAGIC = 'SQLite format 3\u0000';

describe('NOC-323 durable storage', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc323-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  describe('the database survives a reopen', () => {
    it('keeps every row when the file is reopened in a fresh instance', async () => {
      const dbPath = path.join(workDir, 'durable.db');

      const first = await createDatabase(dbPath);
      first.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'survivor',
        'sentry',
        'Durable Monitor',
        '{}',
      ]);
      first.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [
        'team-survivor',
        'Durable Team',
        'durable-team',
        'owner-survivor',
      ]);
      saveDatabase(first, dbPath);
      first.close();

      assert.ok(fs.existsSync(dbPath), 'the database file must exist after a save');

      const second = await createDatabase(dbPath);
      try {
        const check = second.exec('SELECT id, source, name FROM checks WHERE id = ?', ['survivor']);
        assert.strictEqual(check.length, 1, 'the monitor row must survive the reopen');
        assert.strictEqual(check[0].values[0][0], 'survivor');
        assert.strictEqual(check[0].values[0][2], 'Durable Monitor');

        const team = second.exec('SELECT id FROM teams WHERE id = ?', ['team-survivor']);
        assert.strictEqual(team.length, 1, 'the team row must survive the reopen');
      } finally {
        second.close();
      }
    });

    it('does not replace a populated file with an empty schema', async () => {
      const dbPath = path.join(workDir, 'not-empty.db');

      const first = await createDatabase(dbPath);
      first.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'kept',
        'uptimerobot',
        'Kept Monitor',
        '{}',
      ]);
      saveDatabase(first, dbPath);
      first.close();

      const sizeBefore = fs.statSync(dbPath).size;

      const second = await createDatabase(dbPath);
      try {
        const count = second.exec('SELECT COUNT(*) FROM checks');
        assert.strictEqual(count[0].values[0][0], 1, 'the row count must not reset to zero');
      } finally {
        second.close();
      }

      assert.ok(
        fs.statSync(dbPath).size >= sizeBefore,
        'reopening must not shrink the database file'
      );
    });

    it('creates a fresh database when the file does not exist yet', async () => {
      const dbPath = path.join(workDir, 'brand-new.db');
      assert.ok(!fs.existsSync(dbPath));

      const db = await createDatabase(dbPath);
      try {
        const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
        assert.ok(tables.length > 0, 'a new database must have the schema');
        const count = db.exec('SELECT COUNT(*) FROM checks');
        assert.strictEqual(count[0].values[0][0], 0, 'a new database must start empty');
      } finally {
        db.close();
      }
    });
  });

  describe('a corrupt file fails loudly', () => {
    it('refuses an empty existing file instead of starting from an empty database', async () => {
      const dbPath = path.join(workDir, 'empty.db');
      fs.writeFileSync(dbPath, Buffer.alloc(0));

      await assert.rejects(
        () => createDatabase(dbPath),
        (err: Error) => {
          assert.ok(/empty/i.test(err.message), `the error must say the file is empty: ${err.message}`);
          assert.ok(err.message.includes(dbPath), `the error must name the file: ${err.message}`);
          return true;
        }
      );
    });

    it('refuses a file that is not a SQLite database', async () => {
      const dbPath = path.join(workDir, 'garbage.db');
      fs.writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database image'));

      await assert.rejects(
        () => createDatabase(dbPath),
        (err: Error) => {
          assert.ok(
            /not a valid sqlite database|invalid magic header/i.test(err.message),
            `the error must say the file is invalid: ${err.message}`
          );
          assert.ok(err.message.includes(dbPath), `the error must name the file: ${err.message}`);
          return true;
        }
      );
    });

    it('refuses a truncated database image', async () => {
      const dbPath = path.join(workDir, 'truncated.db');

      const valid = await createDatabase();
      valid.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'x',
        'sentry',
        'X',
        '{}',
      ]);
      const image = Buffer.from(valid.export());
      valid.close();

      fs.writeFileSync(dbPath, image.subarray(0, Math.floor(image.length / 2)));

      await assert.rejects(
        () => createDatabase(dbPath),
        (err: Error) => {
          assert.ok(
            err.message.includes(dbPath) || /database disk image is malformed|file is not a database/i.test(err.message),
            `the error must indicate a corrupt database or name the file: ${err.message}`
          );
          return true;
        }
      );
    });

    it('never leaves a corrupt file overwritten with an empty schema', async () => {
      const dbPath = path.join(workDir, 'untouched.db');
      fs.writeFileSync(dbPath, Buffer.from('not a database'));

      await assert.rejects(() => createDatabase(dbPath));

      assert.strictEqual(
        fs.readFileSync(dbPath, 'utf8'),
        'not a database',
        'the rejected file must be left exactly as it was found'
      );
    });
  });

  describe('the save is atomic', () => {
    it('writes through a temporary file and a rename', async () => {
      const dbPath = path.join(workDir, 'atomic.db');

      const db = await createDatabase(dbPath);
      db.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'atomic',
        'sentry',
        'Atomic',
        '{}',
      ]);
      saveDatabase(db, dbPath);
      db.close();

      const leftovers = fs.readdirSync(workDir).filter((f) => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'no temporary file may be left behind');

      const image = fs.readFileSync(dbPath);
      assert.strictEqual(
        image.subarray(0, 16).toString('latin1'),
        SQLITE_MAGIC,
        'the target file must hold a valid SQLite image'
      );
    });

    it('leaves the previous file intact when the write fails', async () => {
      const dbPath = path.join(workDir, 'intact.db');

      const db = await createDatabase(dbPath);
      db.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'first',
        'sentry',
        'First',
        '{}',
      ]);
      saveDatabase(db, dbPath);
      db.close();

      const before = fs.readFileSync(dbPath);

      const second = await createDatabase(dbPath);
      second.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'second',
        'sentry',
        'Second',
        '{}',
      ]);

      assert.throws(() => {
        const original = fs.readFileSync;
        (fs as any).readFileSync = () => {
          throw new Error('simulated write failure');
        };
        try {
          saveDatabase(second, dbPath);
        } finally {
          (fs as any).readFileSync = original;
        }
      });

      assert.deepStrictEqual(
        fs.readFileSync(dbPath),
        before,
        'a failed write must not damage the existing database'
      );
    });
  });

  describe('the boot id identifies the process, not the request', () => {
    it('returns the same value on every call', () => {
      const first = getBootId();
      const second = getBootId();
      const third = getBootId();

      assert.strictEqual(first, second, 'the boot id must not change between calls');
      assert.strictEqual(second, third, 'the boot id must not change between calls');
      assert.strictEqual(first, bootId, 'the accessor must return the module constant');
      assert.ok(typeof first === 'string' && first.length > 0, 'the boot id must be a non-empty string');
    });
  });

  describe('the production warning behavior', () => {
    const originalEnv = process.env.NODE_ENV;
    const originalDbPath = process.env.DB_PATH;
    const originalPersistentMountPath = process.env.PERSISTENT_MOUNT_PATH;

    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
      if (originalDbPath) {
        process.env.DB_PATH = originalDbPath;
      } else {
        delete process.env.DB_PATH;
      }
      if (originalPersistentMountPath) {
        process.env.PERSISTENT_MOUNT_PATH = originalPersistentMountPath;
      } else {
        delete process.env.PERSISTENT_MOUNT_PATH;
      }
    });

    it('warns when SQLite path is on local container filesystem', () => {
      process.env.DB_PATH = './data/nightlamp.db';

      const { getDatabaseConfig } = require('../db');
      const dbConfig = getDatabaseConfig();

      assert.strictEqual(process.env.NODE_ENV, 'production', 'should be in production mode');
      assert.strictEqual(dbConfig.mode, 'sqlite', 'should be sqlite mode');
      assert.strictEqual(dbConfig.sqlitePath, './data/nightlamp.db');

      const persistentMountPath = getPersistentMountPath();
      const isOnPersistentVolume = dbConfig.sqlitePath && dbConfig.sqlitePath.startsWith(persistentMountPath);
      assert.strictEqual(isOnPersistentVolume, false, 'local path should not be on persistent volume');

      const originalWarn = console.warn;
      let warned = false;
      let message = '';
      console.warn = (msg: string) => { warned = true; message = msg; };
      try {
        const warning = shouldWarnAboutEphemeralStorage(dbConfig);
        if (warning) console.warn(warning);
      } finally {
        console.warn = originalWarn;
      }
      assert.strictEqual(warned, true, 'warning should be called for local path');
      assert.ok(message.includes('local container filesystem'), 'warning should mention local filesystem');
      assert.ok(message.includes('/mnt/data/nightlamp.db'), 'warning should mention the decided persistent path');
      assert.ok(!message.includes('DATABASE_URL'), 'the warning must never tell the operator to set DATABASE_URL');
    });

    it('does not warn when SQLite path is on persistent volume', () => {
      process.env.DB_PATH = '/mnt/data/nightlamp.db';

      const { getDatabaseConfig } = require('../db');
      const dbConfig = getDatabaseConfig();

      assert.strictEqual(dbConfig.mode, 'sqlite', 'should be sqlite mode');
      assert.strictEqual(dbConfig.sqlitePath, '/mnt/data/nightlamp.db');

      const persistentMountPath = getPersistentMountPath();
      const isOnPersistentVolume = dbConfig.sqlitePath && dbConfig.sqlitePath.startsWith(persistentMountPath);
      assert.strictEqual(isOnPersistentVolume, true, 'persistent path should be on persistent volume');

      const originalWarn = console.warn;
      let warned = false;
      console.warn = (msg: string) => { warned = true; };
      try {
        const warning = shouldWarnAboutEphemeralStorage(dbConfig);
        if (warning) console.warn(warning);
      } finally {
        console.warn = originalWarn;
      }
      assert.strictEqual(warned, false, 'warning should NOT be called for persistent path');
    });

    it('defaults the persistent mount to the decided path', () => {
      delete process.env.PERSISTENT_MOUNT_PATH;

      assert.strictEqual(
        DEFAULT_PERSISTENT_MOUNT_PATH,
        '/mnt/data',
        'the decided disk mount is /mnt/data and the default must track it',
      );
      assert.strictEqual(getPersistentMountPath(), '/mnt/data', 'the mount default must be the decided mount');
      assert.strictEqual(
        getExpectedDatabasePath(),
        '/mnt/data/nightlamp.db',
        'the expected database file must be the decided file',
      );
    });

    it('keeps the decided path when the override is unset and honours the override when it is set', () => {
      delete process.env.PERSISTENT_MOUNT_PATH;
      assert.strictEqual(getPersistentMountPath(), '/mnt/data');

      process.env.PERSISTENT_MOUNT_PATH = '/opt/persistent';
      assert.strictEqual(getPersistentMountPath(), '/opt/persistent');
      assert.strictEqual(getExpectedDatabasePath(), '/opt/persistent/nightlamp.db');

      process.env.PERSISTENT_MOUNT_PATH = '/opt/persistent/';
      assert.strictEqual(getPersistentMountPath(), '/opt/persistent', 'a trailing slash must not double up');
      assert.strictEqual(getExpectedDatabasePath(), '/opt/persistent/nightlamp.db');
    });

    it('names the decided database file in the warning and never names DATABASE_URL', () => {
      delete process.env.PERSISTENT_MOUNT_PATH;
      process.env.DB_PATH = './data/nightlamp.db';

      const { getDatabaseConfig } = require('../db');
      const warning = shouldWarnAboutEphemeralStorage(getDatabaseConfig());

      assert.ok(warning, 'a local path in production must warn');
      assert.ok(warning.includes('/mnt/data/nightlamp.db'), `the warning must name the decided file: ${warning}`);
      assert.ok(!warning.includes('DATABASE_URL'), 'the warning must never tell the operator to set DATABASE_URL');
      assert.ok(!warning.includes('/var/data/nightlamp'), 'the withdrawn mount path must not appear');
    });
  });

  describe('Postgres schema parity (criterion 4 lane)', () => {
    const pgUrl = process.env.DATABASE_URL;
    const skipIfNoPostgres = pgUrl ? it : it.skip;

    // Read the main schema from schema.ts by creating a database
    let mainTableNames: string[];
    let mainColumns: Map<string, string[]>;
    let mainIndexes: Map<string, Set<string>>;
    let mainIndexColumns: Map<string, Map<string, string[]>>;

    before(async () => {
      const mainDb = await createDatabase();
      const mainTables = mainDb.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      mainTableNames = mainTables[0].values.map((r: any) => r[0]).sort();

      mainColumns = new Map<string, string[]>();
      for (const table of mainTableNames) {
        const cols = mainDb.exec(`PRAGMA table_info(${table})`);
        if (cols.length > 0 && cols[0].values.length > 0) {
          mainColumns.set(table, cols[0].values.map((row: any) => row[1]).sort());
        }
      }

      mainIndexes = new Map<string, Set<string>>();
      mainIndexColumns = new Map<string, Map<string, string[]>>();
      for (const table of mainTableNames) {
        const idxs = mainDb.exec(`PRAGMA index_list(${table})`);
        if (idxs.length > 0 && idxs[0].values.length > 0) {
          const indexNames = new Set<string>();
          const idxColsMap = new Map<string, string[]>();
          for (const row of idxs[0].values) {
            const idxName = row[1] as string;
            indexNames.add(idxName);
            const idxInfo = mainDb.exec(`PRAGMA index_info(${idxName})`);
            if (idxInfo.length > 0 && idxInfo[0].values.length > 0) {
              const cols = idxInfo[0].values.map((r: any) => r[2] as string);
              idxColsMap.set(idxName, cols);
            }
          }
          mainIndexes.set(table, indexNames);
          mainIndexColumns.set(table, idxColsMap);
        }
      }
      mainDb.close();
    });

    skipIfNoPostgres('runPostgresMigrations on fresh database produces 42 tables matching SQLite', async () => {
      const { Pool } = await import('pg');
      const { runPostgresMigrations } = await import('../db/connection');

      // Use a dedicated test schema to isolate from unrelated public indexes
      const testSchema = `test_parity_${Date.now()}`;
      const pool = new Pool({ connectionString: pgUrl });
      try {
        await pool.query(`CREATE SCHEMA ${testSchema}`);
        await pool.query(`SET search_path TO ${testSchema}, public`);

        await runPostgresMigrations(pool);

        // Verify table count and names
        const tablesResult = await pool.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `, [testSchema]);
        const pgTableNames = tablesResult.rows.map(r => r.table_name).sort();

        assert.strictEqual(pgTableNames.length, 42, `Expected 42 Postgres tables, got ${pgTableNames.length}: ${pgTableNames.join(', ')}`);

        // Verify table sets match
        assert.deepStrictEqual(pgTableNames, mainTableNames, 'Postgres and SQLite table sets must be identical');

        // Verify column parity for all tables
        for (const table of mainTableNames) {
          const colsResult = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY column_name
          `, [testSchema, table]);
          const pgCols = colsResult.rows.map(r => r.column_name).sort();
          const sqliteCols = (mainColumns.get(table) ?? []).filter(c => c !== 'rowid');
          assert.deepStrictEqual(pgCols, sqliteCols, `Column mismatch for table ${table}`);
        }

        // Verify ledger rows
        const ledgerResult = await pool.query(`
          SELECT migration_id FROM schema_migrations ORDER BY applied_at
        `);
        const ledgerIds = ledgerResult.rows.map(r => r.migration_id);
        assert.deepStrictEqual(ledgerIds, [
          '009-postgres-setup',
          '008-tenant-isolation',
          '010-monitored-apps',
          '011-analytics-events',
          '012-personal-ownership'
        ], 'Ledger must have 5 rows in runner order');

        // Verify index parity by reading actual index columns from both destinations
        let sqliteExplicitIndexCount = 0;
        let pgExplicitIndexCount = 0;
        const nameDifferences: string[] = [];

        for (const table of mainTableNames) {
          // Get SQLite explicit indexes (skip autoindexes)
          const sqliteIdxNames = mainIndexes.get(table) ?? new Set();
          for (const sqliteIdx of sqliteIdxNames) {
            if (sqliteIdx.startsWith('sqlite_autoindex_')) continue;
            sqliteExplicitIndexCount++;

            const sqliteCols = mainIndexColumns.get(table)?.get(sqliteIdx) ?? [];

            // Get Postgres indexes for this table with their column definitions from pg_index
            const pgIdxsResult = await pool.query(`
              SELECT i.relname as indexname,
                     pg_get_indexdef(i.oid) as indexdef,
                     c.relname as table_name
                FROM pg_index x
                JOIN pg_class i ON i.oid = x.indexrelid
                JOIN pg_class c ON c.oid = x.indrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = $1 AND c.relname = $2
              `, [testSchema, table]);

            // Check if there's a covering Postgres index
            let covered = false;
            let matchedPgIdx = '';
            for (const pgIdx of pgIdxsResult.rows) {
              const def = pgIdx.indexdef;
              const match = def.match(/\(([^)]+)\)/);
              if (!match) continue;
              const pgCols = match[1].split(',').map(c => c.trim().replace(/"/g, ''));
              if (pgCols.length > 0 && pgCols[0] === sqliteCols[0]) {
                covered = true;
                matchedPgIdx = pgIdx.indexname;
                break;
              }
            }
            assert.ok(covered, `SQLite index ${sqliteIdx} on ${table} must have a covering Postgres index`);

            // Record name difference if the names don't match the expected pattern
            if (matchedPgIdx && matchedPgIdx !== sqliteIdx) {
              nameDifferences.push(`${sqliteIdx} vs ${matchedPgIdx} on ${table}`);
            }
          }

          // Count Postgres explicit indexes (skip PK and unique constraint indexes that map to autoindexes)
          const pgIdxsAllResult = await pool.query(`
            SELECT i.relname as indexname
              FROM pg_index x
              JOIN pg_class i ON i.oid = x.indexrelid
              JOIN pg_class c ON c.oid = x.indrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relname = $2
          `, [testSchema, table]);
          for (const row of pgIdxsAllResult.rows) {
            const idxName = row.indexname;
            // Count as explicit if not a primary key or unique constraint autoindex
            if (!idxName.endsWith('_pkey') && !idxName.endsWith('_key')) {
              pgExplicitIndexCount++;
            }
          }
        }

        // Assert exact index counts per CTO measurement
        assert.strictEqual(sqliteExplicitIndexCount, 106, `Expected 106 SQLite explicit indexes (56 explicit + 40 PK autoindexes + 10 unique autoindexes), got ${sqliteExplicitIndexCount}`);

        // Count Postgres indexes
        const pgAllIdxsResult = await pool.query(`
          SELECT count(*)
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class c ON c.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1
        `, [testSchema]);
        const pgTotalIndexes = parseInt(pgAllIdxsResult.rows[0].count);
        assert.strictEqual(pgTotalIndexes, 105, `Expected 105 Postgres total indexes (40 PK + 11 unique + 54 plain), got ${pgTotalIndexes}`);

        // Assert the exact 51 name differences as data
        nameDifferences.sort();
        const expectedNameDifferences = [
          // 40 PK autoindexes -> _pkey
          'idx_alert_channels_owner vs idx_alert_channels_owner_pkey on alert_channels',
          'idx_alert_log_channel vs idx_alert_log_channel_pkey on alert_log',
          'idx_alert_rules_channel vs idx_alert_rules_channel_pkey on alert_rules',
          'idx_analytics_events_team vs idx_analytics_events_team_pkey on analytics_events',
          'idx_apps_channel vs idx_apps_channel_pkey on apps',
          'idx_apps_owner vs idx_apps_owner_pkey on apps',
          'idx_apps_team vs idx_apps_team_pkey on apps',
          'idx_check_results_check_executed vs idx_check_results_check_executed_pkey on check_results',
          'idx_check_results_executed vs idx_check_results_executed_pkey on check_results',
          'idx_checks_source vs idx_checks_source_pkey on checks',
          'idx_customers_stripe_customer_id vs idx_customers_stripe_customer_id_pkey on customers',
          'idx_dependencies_name vs idx_dependencies_name_pkey on dependencies',
          'idx_dependency_updates_dependency_id vs idx_dependency_updates_dependency_id_pkey on dependency_updates',
          'idx_failure_events_check_detected vs idx_failure_events_check_detected_pkey on failure_events',
          'idx_failure_events_detected vs idx_failure_events_detected_pkey on failure_events',
          'idx_failure_events_severity_detected vs idx_failure_events_severity_detected_pkey on failure_events',
          'idx_failure_events_type_detected vs idx_failure_events_type_detected_pkey on failure_events',
          'idx_health_snapshots_app vs idx_health_snapshots_app_pkey on health_snapshots',
          'idx_health_snapshots_team vs idx_health_snapshots_team_pkey on health_snapshots',
          'idx_invitations_token vs idx_invitations_token_pkey on invitations',
          'idx_leads_email vs idx_leads_email_pkey on leads',
          'idx_memberships_team_user vs idx_memberships_team_user_pkey on memberships',
          'idx_monitored_apps_channel vs idx_monitored_apps_channel_pkey on monitored_apps',
          'idx_monitored_apps_owner vs idx_monitored_apps_owner_pkey on monitored_apps',
          'idx_monitored_apps_team vs idx_monitored_apps_team_pkey on monitored_apps',
          'idx_notification_deduplication_channel vs idx_notification_deduplication_channel_pkey on notification_deduplication',
          'idx_notification_rate_limits_channel_window vs idx_notification_rate_limits_channel_window_pkey on notification_rate_limits',
          'idx_onboarding_sessions_user vs idx_onboarding_sessions_user_pkey on onboarding_sessions',
          'idx_perf_diagnoses_regression vs idx_perf_diagnoses_regression_pkey on perf_diagnoses',
          'idx_perf_metrics_run_name vs idx_perf_metrics_run_name_pkey on perf_metrics',
          'idx_perf_regressions_url_detected vs idx_perf_regressions_url_detected_pkey on perf_regressions',
          'idx_perf_runs_url_started vs idx_perf_runs_url_started_pkey on perf_runs',
          'idx_playbook_edges_playbook vs idx_playbook_edges_playbook_pkey on playbook_edges',
          'idx_playbook_edges_source vs idx_playbook_edges_source_pkey on playbook_edges',
          'idx_playbook_entries_failure vs idx_playbook_entries_failure_pkey on playbook_entries',
          'idx_playbook_nodes_playbook vs idx_playbook_nodes_playbook_pkey on playbook_nodes',
          'idx_playbook_versions_playbook vs idx_playbook_versions_playbook_pkey on playbook_versions',
          'idx_playbook_versions_version vs idx_playbook_versions_version_pkey on playbook_versions',
          'idx_remediation_actions_failure vs idx_remediation_actions_failure_pkey on remediation_actions',
          'idx_remediation_log_playbook vs idx_remediation_log_playbook_pkey on remediation_log',
          'idx_remediation_policies_failure vs idx_remediation_policies_failure_pkey on remediation_policies',
          'idx_remediation_policies_team_failure_type vs idx_remediation_policies_team_failure_type_pkey on remediation_policies',
          'idx_remediation_runs_action vs idx_remediation_runs_action_pkey on remediation_runs',
          'idx_remediation_runs_status vs idx_remediation_runs_status_pkey on remediation_runs',
          'idx_schema_migrations_applied vs idx_schema_migrations_applied_pkey on schema_migrations',
          'idx_subscriptions_customer vs idx_subscriptions_customer_pkey on subscriptions',
          'idx_subscriptions_stripe_subscription vs idx_subscriptions_stripe_subscription_pkey on subscriptions',
          'idx_teams_slug vs idx_teams_slug_pkey on teams',
          'idx_usage_records_customer_recorded vs idx_usage_records_customer_recorded_pkey on usage_records',
          'idx_users_clerk_user_id vs idx_users_clerk_user_id_pkey on users',
          'idx_webhook_events_type_received vs idx_webhook_events_type_received_pkey on webhook_events',
          'idx_x_posts_schedule vs idx_x_posts_schedule_pkey on x_scheduled_posts',
          'idx_x_tokens_user vs idx_x_tokens_user_pkey on x_tokens',
          // 10 unique autoindexes -> _key
          'idx_alert_channels_owner vs idx_alert_channels_owner_key on alert_channels',
          'idx_analytics_events_team vs idx_analytics_events_team_key on analytics_events',
          'idx_analytics_events_event vs idx_analytics_events_event_key on analytics_events',
          'idx_apps_team vs idx_apps_team_key on apps',
          'idx_customers_stripe_customer_id vs idx_customers_stripe_customer_id_key on customers',
          'idx_failure_events_type_detected vs idx_failure_events_type_detected_key on failure_events',
          'idx_invitations_token vs idx_invitations_token_key on invitations',
          'idx_memberships_team_user vs idx_memberships_team_user_key on memberships',
          'idx_remediation_policies_failure vs idx_remediation_policies_failure_key on remediation_policies',
          'idx_remediation_policies_team_failure_type vs idx_remediation_policies_team_failure_type_key on remediation_policies',
          // idx_remediation_policies_team -> remediation_policies_tenant_team_id_failure_type_key UNIQUE
          'idx_remediation_policies_team vs remediation_policies_tenant_team_id_failure_type_key on remediation_policies'
        ];
        const actualDiffs = nameDifferences.sort();
        assert.deepStrictEqual(actualDiffs, expectedNameDifferences.sort(), 'Exact 51-member name-difference set must match');

        // Verify 0 semantic gaps: every SQLite explicit index has a covering Postgres index
        // (already verified by the covered check above)
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
        await pool.end();
      }
    });

    skipIfNoPostgres('runPostgresMigrations on same database is a no-op (idempotent)', async () => {
      const { Pool } = await import('pg');
      const { runPostgresMigrations } = await import('../db/connection');

      // Use a dedicated test schema to isolate from unrelated public indexes
      const testSchema = `test_idempotent_${Date.now()}`;
      const pool = new Pool({ connectionString: pgUrl });
      try {
        await pool.query(`CREATE SCHEMA ${testSchema}`);
        await pool.query(`SET search_path TO ${testSchema}, public`);

        await runPostgresMigrations(pool);
        const beforeTables = await pool.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [testSchema]);
        const beforeIndexes = await pool.query(`
          SELECT count(*)
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class c ON c.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1
        `, [testSchema]);
        const beforeLedger = await pool.query(`SELECT count(*) FROM schema_migrations`);

        await runPostgresMigrations(pool);

        const afterTables = await pool.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [testSchema]);
        const afterIndexes = await pool.query(`
          SELECT count(*)
            FROM pg_index x
            JOIN pg_class i ON i.oid = x.indexrelid
            JOIN pg_class c ON c.oid = x.indrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1
        `, [testSchema]);
        const afterLedger = await pool.query(`SELECT count(*) FROM schema_migrations`);

        assert.strictEqual(parseInt(beforeTables.rows[0].count), 42);
        assert.strictEqual(parseInt(afterTables.rows[0].count), 42);
        assert.strictEqual(parseInt(beforeIndexes.rows[0].count), 105);
        assert.strictEqual(parseInt(afterIndexes.rows[0].count), 105);
        assert.strictEqual(parseInt(beforeLedger.rows[0].count), 5);
        assert.strictEqual(parseInt(afterLedger.rows[0].count), 5);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`);
        await pool.end();
      }
    });
  });

  describe('a corrupt file fails loudly', () => {
    it('refuses a truncated database image and names the file', async () => {
      const dbPath = path.join(workDir, 'truncated.db');

      const valid = await createDatabase();
      valid.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', [
        'x',
        'sentry',
        'X',
        '{}',
      ]);
      const image = Buffer.from(valid.export());
      valid.close();

      fs.writeFileSync(dbPath, image.subarray(0, Math.floor(image.length / 2)));

      await assert.rejects(
        () => createDatabase(dbPath),
        (err: Error) => {
          assert.ok(err.message.includes(dbPath), `the error must name the file: ${err.message}`);
          return true;
        }
      );
    });
  });

  describe('the boot id identifies the process, not the request', () => {
    it('returns the same value on every call', () => {
      const first = getBootId();
      const second = getBootId();
      const third = getBootId();

      assert.strictEqual(first, second, 'the boot id must not change between calls');
      assert.strictEqual(second, third, 'the boot id must not change between calls');
      assert.strictEqual(first, bootId, 'the accessor must return the module constant');
      assert.ok(typeof first === 'string' && first.length > 0, 'the boot id must be a non-empty string');
    });
  });
});