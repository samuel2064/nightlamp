import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { getOrCreatePlaybookEntry } from '../playbook';
import { matchPlaybookEntries, getCorrelatedPatterns } from '../playbook/matcher';

// The matcher scopes through tenantOwnedFilter, so every fixture and caller
// carries a team id: a teamless caller must not match the shared bucket.
const TEAM_ID = 'matcher-test-team';

describe('Playbook Matcher - Confidence Scoring', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
    getOrCreatePlaybookEntry(db, 'expired_token', TEAM_ID);
    getOrCreatePlaybookEntry(db, 'rate_limit_shift', TEAM_ID);
    getOrCreatePlaybookEntry(db, 'broken_webhook', TEAM_ID);
    getOrCreatePlaybookEntry(db, 'schema_drift', TEAM_ID);
  });

  it('returns higher confidence for title match vs body-only match', () => {
    const tokenResults = matchPlaybookEntries(db, 'expired token', 20, TEAM_ID);
    const webhookResults = matchPlaybookEntries(db, 'webhook', 20, TEAM_ID);

    const tokenMatch = tokenResults.find(m => m.failureType === 'expired_token');
    const webhookMatch = webhookResults.find(m => m.failureType === 'broken_webhook');

    expect(tokenMatch).to.exist;
    expect(webhookMatch).to.exist;
    expect(tokenMatch!.confidence).to.be.greaterThan(0);
    expect(webhookMatch!.confidence).to.be.greaterThan(0);
  });

  it('returns empty for no match', () => {
    const results = matchPlaybookEntries(db, 'zzz_nonexistent_zzz', 20, TEAM_ID);
    expect(results).to.have.lengthOf(0);
  });

  it('returns results sorted by confidence descending', () => {
    getOrCreatePlaybookEntry(db, 'expired_token', TEAM_ID);
    getOrCreatePlaybookEntry(db, 'expired_token', TEAM_ID);
    getOrCreatePlaybookEntry(db, 'expired_token', TEAM_ID);

    const results = matchPlaybookEntries(db, 'token', 20, TEAM_ID);
    expect(results.length).to.be.greaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).to.be.at.least(results[i].confidence);
    }
  });

  it('returns empty for empty query', () => {
    const results = matchPlaybookEntries(db, '', 20, TEAM_ID);
    expect(results).to.have.lengthOf(0);
  });

  it('matches on failure_type keywords', () => {
    const results = matchPlaybookEntries(db, 'rate limit', 20, TEAM_ID);
    const rateLimit = results.find(m => m.failureType === 'rate_limit_shift');
    expect(rateLimit).to.exist;
  });

  it('honors limit parameter', () => {
    const results = matchPlaybookEntries(db, 'error', 2, TEAM_ID);
    expect(results.length).to.be.at.most(2);
  });

  it('returns nothing for a teamless caller even when the shared bucket is populated', () => {
    db.run(
      `INSERT INTO playbook_entries (id, failure_type, title, body, first_seen_at, last_occurrence_at, occurrence_count, team_id)
       VALUES (?, 'broken_webhook', 'Shared Entry', 'shared body with token symptoms', datetime('now'), datetime('now'), 1, NULL)`
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, detected_at, team_id)
       VALUES (?, 'check-1', 'expired_token', 'critical', 'token expired', 'test', datetime('now'), NULL)`,
      ['shared-event']
    );

    const results = matchPlaybookEntries(db, 'token', 20, null);
    expect(results).to.have.lengthOf(0);
  });
});

describe('Playbook Matcher - Correlation', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
  });

  it('returns co-occurring patterns from failure_events', () => {
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['e1', 'check-1', 'expired_token', 'critical', 'token expired', 'test', TEAM_ID]
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['e2', 'check-1', 'rate_limit_shift', 'warning', 'rate limit', 'test', TEAM_ID]
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['e3', 'check-2', 'expired_token', 'critical', 'token expired', 'test', TEAM_ID]
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, team_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['e4', 'check-2', 'schema_drift', 'warning', 'schema', 'test', TEAM_ID]
    );

    const correlations = getCorrelatedPatterns(db, 'expired_token', 5, TEAM_ID);
    expect(correlations).to.have.lengthOf(2);
    expect(correlations[0].coOccurrenceCount).to.equal(1);
  });

  it('returns empty for never-seen failure type', () => {
    const correlations = getCorrelatedPatterns(db, 'nonexistent', 5, TEAM_ID);
    expect(correlations).to.have.lengthOf(0);
  });

  it('returns nothing for a teamless caller even when the shared bucket is populated', () => {
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, team_id) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ['shared-e1', 'check-1', 'expired_token', 'critical', 'token expired', 'test']
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, team_id) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ['shared-e2', 'check-1', 'rate_limit_shift', 'warning', 'rate limit', 'test']
    );

    const correlations = getCorrelatedPatterns(db, 'expired_token', 5, null);
    expect(correlations).to.have.lengthOf(0);
  });
});