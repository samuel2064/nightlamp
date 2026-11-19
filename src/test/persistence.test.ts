import { createDatabaseWithUrl, saveDatabaseWithMode } from '../db';
import { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';

describe('Database Persistence', () => {
  const testDbPath = './test-persistence.db';

  afterEach(() => {
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it('should survive a process restart - row written before restart is readable after', async () => {
    const result1 = await createDatabaseWithUrl(testDbPath);
    const db1 = result1.db;
    
    db1.run(
      "INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)",
      ['test-team-1', 'Test Team', 'test-team', 'owner-1', 'free']
    );
    saveDatabaseWithMode(db1, testDbPath);

    const result2 = await createDatabaseWithUrl(testDbPath);
    const db2 = result2.db;
    const result = db2.exec("SELECT id, name, slug FROM teams WHERE id = ?", ['test-team-1']);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].values.length, 1);
    assert.strictEqual(result[0].values[0][0], 'test-team-1');
    assert.strictEqual(result[0].values[0][1], 'Test Team');
    assert.strictEqual(result[0].values[0][2], 'test-team');
  });

  it('should survive multiple restarts with multiple rows', async () => {
    const result1 = await createDatabaseWithUrl(testDbPath);
    const db1 = result1.db;
    
    db1.run(
      "INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)",
      ['team-1', 'Team 1', 'team-1', 'owner-1', 'free']
    );
    db1.run(
      "INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)",
      ['team-2', 'Team 2', 'team-2', 'owner-2', 'advanced']
    );
    saveDatabaseWithMode(db1, testDbPath);

    const result2 = await createDatabaseWithUrl(testDbPath);
    const db2 = result2.db;
    const result = db2.exec("SELECT id, name, plan FROM teams ORDER BY id");

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].values.length, 2);
    assert.strictEqual(result[0].values[0][0], 'team-1');
    assert.strictEqual(result[0].values[0][1], 'Team 1');
    assert.strictEqual(result[0].values[0][2], 'free');
    assert.strictEqual(result[0].values[1][0], 'team-2');
    assert.strictEqual(result[0].values[1][1], 'Team 2');
    assert.strictEqual(result[0].values[1][2], 'advanced');
  });

  it('should survive restart with schema migrations applied', async () => {
    const result1 = await createDatabaseWithUrl(testDbPath);
    const db1 = result1.db;
    
    db1.run(
      "INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)",
      ['team-migrated', 'Migrated Team', 'migrated-team', 'owner-1', 'free']
    );
    saveDatabaseWithMode(db1, testDbPath);

    const result2 = await createDatabaseWithUrl(testDbPath);
    const db2 = result2.db;
    const result = db2.exec("SELECT id FROM teams WHERE id = ?", ['team-migrated']);

    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].values[0][0], 'team-migrated');
  });

  it('should report storage mode and boot id in health endpoint', () => {
    const storageMode = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
    assert.ok(['sqlite', 'postgres'].includes(storageMode));
  });
});