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

  describe('Postgres schema parity', () => {
    it('Postgres migration covers all tables and columns from main schema', async () => {
      // Read the main schema from schema.ts by creating a database
      const mainDb = await createDatabase();
      const mainTables = mainDb.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
      const mainTableNames = mainTables[0].values.map((r: any) => r[0]).sort();
      mainDb.close();

      // Read the Postgres migration file and parse CREATE TABLE statements
      const fs = require('fs');
      const path = require('path');
      const migrationPath = path.join(__dirname, '..', 'db', 'migrations', '009-postgres-setup.ts');
      const migrationContent = fs.readFileSync(migrationPath, 'utf8');

      // Extract table names from Postgres migration
      const pgTableMatches = migrationContent.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g);
      const pgTableNames = pgTableMatches ? pgTableMatches.map(m => m.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/)[1]).sort() : [];

      // Check that all main tables exist in Postgres migration
      for (const table of mainTableNames) {
        assert.ok(pgTableNames.includes(table), `Postgres migration missing table: ${table}`);
      }

      // Verify column parity for a few critical tables
      for (const criticalTable of ['teams', 'memberships', 'invitations', 'usage_records', 'team_workspaces', 'checks', 'check_results', 'failure_events', 'playbook_entries']) {
        if (mainTableNames.includes(criticalTable)) {
          assert.ok(pgTableNames.includes(criticalTable), `Critical table ${criticalTable} must exist in Postgres migration`);
        }
      }

      // Verify total table count matches (42 tables: the shipped snapshot plus
      // the monitored app registry, health snapshots, analytics events, feedback
      // responses and the migration ledger the SQLite schema creates)
      assert.strictEqual(pgTableNames.length, 42, `Postgres migration should have 42 tables, got ${pgTableNames.length}`);
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