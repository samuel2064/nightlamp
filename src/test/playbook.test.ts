import { createDatabase } from '../db/schema';
import { getOrCreatePlaybookEntry, writePlaybookFile } from '../playbook/writer';
import { classifyFailure } from '../classifier';
import { Database } from 'sql.js';
import * as fs from 'fs';
import * as path from 'path';
import assert from 'assert';

describe('Playbook Writer', () => {
  let db: Database;

  before(async () => {
    db = await createDatabase();
  });

  after(() => {
    if (db) db.close();
  });

  it('should create new playbook entry on first occurrence', () => {
    const entry = getOrCreatePlaybookEntry(db, 'expired_token');
    assert.strictEqual(entry.failureType, 'expired_token');
    assert.ok(entry.title.includes('Expired'));
    assert.strictEqual(entry.occurrenceCount, 1);
  });

  it('should increment occurrence count on repeat', () => {
    const entry = getOrCreatePlaybookEntry(db, 'expired_token');
    assert.strictEqual(entry.occurrenceCount, 2);
  });

  it('should create entries for all failure types', () => {
    const types = ['broken_webhook', 'schema_drift', 'rate_limit_shift', 'error_spike', 'new_error_pattern'] as const;
    for (const t of types) {
      const entry = getOrCreatePlaybookEntry(db, t);
      assert.ok(entry.title.length > 0);
      assert.strictEqual(entry.failureType, t);
    }
  });

  it('should write playbook to markdown file', () => {
    const dir = './test-playbook-output';
    const entry = getOrCreatePlaybookEntry(db, 'expired_token');
    const filePath = writePlaybookFile(dir, entry);
    assert.ok(fs.existsSync(filePath));

    const content = fs.readFileSync(filePath, 'utf-8');
    assert.ok(content.includes('# Expired Token Investigation'));
    assert.ok(content.includes('## Expired Token'));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('should trigger playbook creation via classification + playbook pipeline', () => {
    const events = classifyFailure('test-check', { statusCode: 401, errorMessage: 'token expired' });
    assert.strictEqual(events.length, 1);

    for (const event of events) {
      const entry = getOrCreatePlaybookEntry(db, event.failureType);
      assert.strictEqual(entry.failureType, 'expired_token');
      assert.ok(entry.body.includes('401'));
    }
  });
});