import { createDatabase, saveDatabase } from '../db/schema';
import { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';

describe('Database', () => {
  let db: Database;

  before(async () => {
    db = await createDatabase();
  });

  after(() => {
    if (db) db.close();
  });

  it('should create all tables', () => {
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables[0].values.map((r: any) => r[0]).sort();
    assert.deepStrictEqual(names, ['check_results', 'checks', 'customers', 'dependencies', 'dependency_updates', 'failure_events', 'perf_diagnoses', 'perf_metrics', 'perf_regressions', 'perf_runs', 'playbook_entries', 'remediation_log', 'subscriptions', 'usage_records']);
  });

  it('should insert and query a check', () => {
    db.run('INSERT INTO checks (id, source, name, config) VALUES (?, ?, ?, ?)', ['c1', 'test', 'Test Check', '{}']);
    const result = db.exec('SELECT id, source, name FROM checks WHERE id = ?', ['c1']);
    assert.strictEqual(result[0].values[0][0], 'c1');
    assert.strictEqual(result[0].values[0][1], 'test');
  });

  it('should insert and query a check result', () => {
    db.run('INSERT INTO check_results (id, check_id, status, summary) VALUES (?, ?, ?, ?)', ['r1', 'c1', 'pass', 'All good']);
    const result = db.exec('SELECT status, summary FROM check_results WHERE id = ?', ['r1']);
    assert.strictEqual(result[0].values[0][0], 'pass');
  });

  it('should insert and query a failure event', () => {
    db.run('INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)',
      ['f1', 'c1', 'expired_token', 'critical', 'Token expired', 'Auth failed']);
    const result = db.exec('SELECT failure_type, severity FROM failure_events WHERE id = ?', ['f1']);
    assert.strictEqual(result[0].values[0][0], 'expired_token');
    assert.strictEqual(result[0].values[0][1], 'critical');
  });

  it('should insert and query a playbook entry', () => {
    db.run('INSERT INTO playbook_entries (id, failure_type, title, body) VALUES (?, ?, ?, ?)',
      ['p1', 'expired_token', 'Expired Token', '## Diagnostic steps']);
    const result = db.exec('SELECT title FROM playbook_entries WHERE id = ?', ['p1']);
    assert.strictEqual(result[0].values[0][0], 'Expired Token');
  });

  it('should save and reload database', () => {
    const dbPath = './test-save.db';
    saveDatabase(db, dbPath);
    assert.ok(fs.existsSync(dbPath));
    fs.unlinkSync(dbPath);
  });
});