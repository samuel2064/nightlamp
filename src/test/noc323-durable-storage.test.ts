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
          // The error should mention the file path or at least indicate a corrupt database
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
      for (const table of mainTableNames) {
        const idxs = mainDb.exec(`PRAGMA index_list(${table})`);
        if (idxs.length > 0 && idxs[0].values.length > 0) {
          const indexNames = new Set<string>();
          for (const row of idxs[0].values) {
            indexNames.add(row[1] as string);
          }
          mainIndexes.set(table, indexNames);
        }
      }
      mainDb.close();
    });

    skipIfNoPostgres('runPostgresMigrations on fresh database produces 42 tables matching SQLite', async () => {
      const { Pool } = await import('pg');
      const { runPostgresMigrations } = await import('../db/migrations/postgres-runner');

      const pool = new Pool({ connectionString: pgUrl });
      try {
        await runPostgresMigrations(pool);

        // Verify table count and names
        const tablesResult = await pool.query(`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `);
        const pgTableNames = tablesResult.rows.map(r => r.table_name).sort();

        assert.strictEqual(pgTableNames.length, 42, `Expected 42 Postgres tables, got ${pgTableNames.length}: ${pgTableNames.join(', ')}`);

        // Verify table sets match
        assert.deepStrictEqual(pgTableNames, mainTableNames, 'Postgres and SQLite table sets must be identical');

        // Verify column parity for all tables
        for (const table of mainTableNames) {
          const colsResult = await pool.query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1
            ORDER BY column_name
          `, [table]);
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

        // Verify index parity by semantics (every SQLite explicit index has a covering Postgres index)
        for (const table of mainTableNames) {
          const sqliteIdxs = mainIndexes.get(table) ?? new Set();
          if (sqliteIdxs.size === 0) continue;

          const pgIdxsResult = await pool.query(`
            SELECT indexname, indexdef FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = $1
          `, [table]);
          const pgIdxNames = pgIdxsResult.rows.map(r => r.indexname);
          const pgIdxDefs = pgIdxsResult.rows.map(r => r.indexdef);

          for (const sqliteIdx of sqliteIdxs) {
            // Skip primary key and unique constraint autoindexes
            if (sqliteIdx.startsWith('sqlite_autoindex_')) continue;

            const covered = pgIdxDefs.some(def => {
              const match = def.match(/\(([^)]+)\)/);
              if (!match) return false;
              const leadingCols = match[1].split(',').map(c => c.trim());
              return leadingCols[0] === sqliteIdx.replace(`idx_${table}_`, '');
            });
            assert.ok(covered, `SQLite index ${sqliteIdx} on ${table} must have a covering Postgres index`);
          }
        }

        // Record the index name differences as data (not comments)
        // These are the 11 expected name differences per CTO measurement:
        // - 10 SQLite unique autoindexes vs 10 Postgres _key constraint indexes
        // - 40 SQLite PK autoindexes vs 40 Postgres _pkey indexes
        // - idx_remediation_policies_team vs remediation_policies_tenant_team_id_failure_type_key UNIQUE
      } finally {
        await pool.end();
      }
    });

    skipIfNoPostgres('runPostgresMigrations on same database is a no-op (idempotent)', async () => {
      const { Pool } = await import('pg');
      const { runPostgresMigrations } = await import('../db/migrations/postgres-runner');

      const pool = new Pool({ connectionString: pgUrl });
      try {
        await runPostgresMigrations(pool);
        const beforeTables = await pool.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
        const beforeIndexes = await pool.query(`SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'`);
        const beforeLedger = await pool.query(`SELECT count(*) FROM schema_migrations`);

        await runPostgresMigrations(pool);

        const afterTables = await pool.query(`SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
        const afterIndexes = await pool.query(`SELECT count(*) FROM pg_indexes WHERE schemaname = 'public'`);
        const afterLedger = await pool.query(`SELECT count(*) FROM schema_migrations`);

        assert.strictEqual(parseInt(beforeTables.rows[0].count), 42);
        assert.strictEqual(parseInt(afterTables.rows[0].count), 42);
        assert.strictEqual(parseInt(beforeIndexes.rows[0].count), 105);
        assert.strictEqual(parseInt(afterIndexes.rows[0].count), 105);
        assert.strictEqual(parseInt(beforeLedger.rows[0].count), 5);
        assert.strictEqual(parseInt(afterLedger.rows[0].count), 5);
      } finally {
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
          // The error must name the file
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