import assert from 'assert';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import {
  ensureCheck,
  deduplicateChecks,
  disablePlaceholderChecks,
  sanitizeChecks,
} from '../engine';
import {
  isPlaceholderCredential,
  isSentryConfigPlaceholder,
  isUptimeRobotConfigPlaceholder,
} from '../connectors';

function countChecks(db: Database, where = '1=1', params: any[] = []): number {
  const result = db.exec(`SELECT COUNT(*) FROM checks WHERE ${where}`, params);
  return Number(result[0]?.values[0]?.[0] || 0);
}

describe('Monitor seeding idempotency', function () {
  let db: Database;

  beforeEach(async function () {
    db = await createDatabase();
  });

  afterEach(function () {
    db.close();
  });

  it('creates exactly one monitor row for repeated polls', function () {
    const first = ensureCheck(db, 'uptimerobot', 'UptimeRobot Monitor', { apiKey: 'ur-real-key' });
    const second = ensureCheck(db, 'uptimerobot', 'UptimeRobot Monitor', { apiKey: 'ur-real-key' });
    const third = ensureCheck(db, 'uptimerobot', 'UptimeRobot Monitor', { apiKey: 'ur-real-key' });

    assert.strictEqual(first, second);
    assert.strictEqual(second, third);
    assert.strictEqual(countChecks(db), 1);
    assert.strictEqual(countChecks(db, 'enabled = 1'), 1);
  });

  it('refreshes config on the same row instead of inserting a duplicate', function () {
    const id = ensureCheck(db, 'sentry', 'Sentry Error Monitor', {
      authToken: 'old-token',
      orgSlug: 'nightlamp',
      projectSlug: 'web',
    });
    const sameId = ensureCheck(db, 'sentry', 'Sentry Error Monitor', {
      authToken: 'new-token',
      orgSlug: 'nightlamp',
      projectSlug: 'web',
    });

    assert.strictEqual(id, sameId);
    assert.strictEqual(countChecks(db), 1);
    const stored = db.exec('SELECT config FROM checks WHERE id = ?', [id]);
    assert.ok((stored[0].values[0][0] as string).includes('new-token'));
  });

  it('collapses pre-existing duplicate monitor rows', function () {
    db.run(`INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)`,
      ['dup-1', 'uptimerobot', 'UptimeRobot Monitor', '{"apiKey":"ur-1"}', 1]);
    db.run(`INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)`,
      ['dup-2', 'uptimerobot', 'UptimeRobot Monitor', '{"apiKey":"ur-2"}', 1]);
    db.run(`INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)`,
      ['dup-3', 'uptimerobot', 'UptimeRobot Monitor', '{"apiKey":"ur-3"}', 1]);

    const disabled = deduplicateChecks(db);

    assert.strictEqual(disabled, 2);
    assert.strictEqual(countChecks(db), 3);
    assert.strictEqual(countChecks(db, 'enabled = 1'), 1);
    const kept = db.exec(`SELECT id FROM checks WHERE enabled = 1`);
    assert.strictEqual(kept[0].values[0][0], 'dup-1');
  });

  it('disables monitors holding placeholder credentials', function () {
    ensureCheck(db, 'uptimerobot', 'UptimeRobot Monitor', { apiKey: 'ur_...' });
    ensureCheck(db, 'sentry', 'Sentry Error Monitor', {
      authToken: 'sntrys_...',
      orgSlug: 'your-org-slug',
      projectSlug: 'nightlamp',
    });
    ensureCheck(db, 'uptimerobot', 'Real UptimeRobot Monitor', { apiKey: 'ur-1234567890' });

    const disabled = disablePlaceholderChecks(db);

    assert.strictEqual(disabled, 2);
    assert.strictEqual(countChecks(db, 'enabled = 1'), 1);
    const enabled = db.exec(`SELECT name FROM checks WHERE enabled = 1`);
    assert.strictEqual(enabled[0].values[0][0], 'Real UptimeRobot Monitor');
  });

  it('runs dedupe and placeholder cleanup together', function () {
    db.run(`INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)`,
      ['p-1', 'sentry', 'Sentry Error Monitor', '{"authToken":"your_sentry_auth_token","orgSlug":"your_org_slug","projectSlug":"your_project_slug"}', 1]);
    db.run(`INSERT INTO checks (id, source, name, config, enabled) VALUES (?, ?, ?, ?, ?)`,
      ['p-2', 'sentry', 'Sentry Error Monitor', '{"authToken":"your_sentry_auth_token","orgSlug":"your_org_slug","projectSlug":"your_project_slug"}', 1]);

    const result = sanitizeChecks(db);

    assert.strictEqual(result.duplicatesDisabled, 1);
    assert.strictEqual(result.placeholdersDisabled, 1);
    assert.strictEqual(countChecks(db, 'enabled = 1'), 0);
  });
});

describe('Placeholder credential detection', function () {
  it('detects scaffold values and missing values', function () {
    for (const value of [undefined, '', '   ', 'your_uptimerobot_api_key', 'ur_...', 'sntrys_...', 'your-org-slug', 'changeme', 'placeholder']) {
      assert.strictEqual(isPlaceholderCredential(value as any), true, `expected ${String(value)} to be a placeholder`);
    }
  });

  it('accepts realistic credential values', function () {
    assert.strictEqual(isPlaceholderCredential('ur-1234567890abcdef'), false);
    assert.strictEqual(isPlaceholderCredential('sntrys_abc123def456'), false);
    assert.strictEqual(isPlaceholderCredential('my-org'), false);
  });

  it('flags sentry configs with any placeholder field', function () {
    assert.strictEqual(isSentryConfigPlaceholder({ authToken: 'sntrys_abc123', orgSlug: 'your-org-slug', projectSlug: 'web' }), true);
    assert.strictEqual(isSentryConfigPlaceholder({ authToken: 'sntrys_abc123', orgSlug: 'nightlamp', projectSlug: 'web' }), false);
  });

  it('flags uptimerobot configs with a placeholder key', function () {
    assert.strictEqual(isUptimeRobotConfigPlaceholder({ apiKey: 'your_uptimerobot_api_key' }), true);
    assert.strictEqual(isUptimeRobotConfigPlaceholder({ apiKey: 'ur-1234567890' }), false);
  });
});
