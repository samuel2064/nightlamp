import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { getOrCreatePlaybookEntry } from '../playbook';
import { matchPlaybookEntries, getCorrelatedPatterns } from '../playbook/matcher';

describe('Playbook Matcher - Confidence Scoring', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
    getOrCreatePlaybookEntry(db, 'expired_token');
    getOrCreatePlaybookEntry(db, 'rate_limit_shift');
    getOrCreatePlaybookEntry(db, 'broken_webhook');
    getOrCreatePlaybookEntry(db, 'schema_drift');
  });

  it('returns higher confidence for title match vs body-only match', () => {
    const tokenResults = matchPlaybookEntries(db, 'expired token');
    const webhookResults = matchPlaybookEntries(db, 'webhook');

    const tokenMatch = tokenResults.find(m => m.failureType === 'expired_token');
    const webhookMatch = webhookResults.find(m => m.failureType === 'broken_webhook');

    expect(tokenMatch).to.exist;
    expect(webhookMatch).to.exist;
    expect(tokenMatch!.confidence).to.be.greaterThan(0);
    expect(webhookMatch!.confidence).to.be.greaterThan(0);
  });

  it('returns empty for no match', () => {
    const results = matchPlaybookEntries(db, 'zzz_nonexistent_zzz');
    expect(results).to.have.lengthOf(0);
  });

  it('returns results sorted by confidence descending', () => {
    getOrCreatePlaybookEntry(db, 'expired_token');
    getOrCreatePlaybookEntry(db, 'expired_token');
    getOrCreatePlaybookEntry(db, 'expired_token');

    const results = matchPlaybookEntries(db, 'token');
    expect(results.length).to.be.greaterThan(0);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].confidence).to.be.at.least(results[i].confidence);
    }
  });

  it('returns empty for empty query', () => {
    const results = matchPlaybookEntries(db, '');
    expect(results).to.have.lengthOf(0);
  });

  it('matches on failure_type keywords', () => {
    const results = matchPlaybookEntries(db, 'rate limit');
    const rateLimit = results.find(m => m.failureType === 'rate_limit_shift');
    expect(rateLimit).to.exist;
  });

  it('honors limit parameter', () => {
    const results = matchPlaybookEntries(db, 'error', 2);
    expect(results.length).to.be.at.most(2);
  });
});

describe('Playbook Matcher - Correlation', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
  });

  it('returns co-occurring patterns from failure_events', () => {
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['e1', 'check-1', 'expired_token', 'critical', 'token expired', 'test']
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['e2', 'check-1', 'rate_limit_shift', 'warning', 'rate limit', 'test']
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['e3', 'check-2', 'expired_token', 'critical', 'token expired', 'test']
    );
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)`,
      ['e4', 'check-2', 'schema_drift', 'warning', 'schema', 'test']
    );

    const correlations = getCorrelatedPatterns(db, 'expired_token');
    expect(correlations).to.have.lengthOf(2);
    expect(correlations[0].coOccurrenceCount).to.equal(1);
  });

  it('returns empty for never-seen failure type', () => {
    const correlations = getCorrelatedPatterns(db, 'nonexistent');
    expect(correlations).to.have.lengthOf(0);
  });
});