import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { getOrCreatePlaybookEntry } from '../playbook';
import { runRemediation, getRemediationLogs } from '../remediation/engine';
import { classifyFailure } from '../classifier';

describe('End-to-End Pipeline Integration', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
  });

  it('poll -> classify -> playbook -> auto-remediate (full pipeline, first occurrence)', async () => {
    const checkId = 'e2e-check-1';

    const events = classifyFailure(checkId, {
      statusCode: 401,
      errorMessage: 'expired token detected',
    });

    expect(events).to.have.lengthOf(1);
    expect(events[0].failureType).to.equal('expired_token');

    for (const event of events) {
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)`,
        [event.id, checkId, event.failureType, event.severity, event.title, event.description]
      );
    }

    const entry = getOrCreatePlaybookEntry(db, events[0].failureType);
    expect(entry.occurrenceCount).to.equal(1);

    const preRemediation = getRemediationLogs(db);
    expect(preRemediation.count).to.equal(0);
  });

  it('poll -> classify -> playbook -> auto-remediate (second occurrence triggers remediation)', async () => {
    const checkId = 'e2e-check-2';

    getOrCreatePlaybookEntry(db, 'expired_token');

    const events = classifyFailure(checkId, {
      statusCode: 403,
      errorMessage: 'unauthorized: token invalid',
    });

    const tokenEvent = events.find(e => e.failureType === 'expired_token');
    expect(tokenEvent).to.exist;

    for (const event of events) {
      db.run(
        `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)`,
        [event.id, checkId, event.failureType, event.severity, event.title, event.description]
      );
    }

    const entry = getOrCreatePlaybookEntry(db, tokenEvent!.failureType);
    expect(entry.occurrenceCount).to.be.at.least(2);

    const result = await runRemediation(db, entry);
    expect(result.logId).to.be.a('string');
    expect(result.status).to.equal('success');

    const { logs } = getRemediationLogs(db);
    expect(logs).to.have.lengthOf(1);
    expect(logs[0].failureType).to.equal('expired_token');
  });

  it('multiple failure types across multiple checks (realistic scenario)', async () => {
    const checkId1 = 'e2e-multi-1';
    const checkId2 = 'e2e-multi-2';

    const events1 = classifyFailure(checkId1, { statusCode: 401, errorMessage: 'token expired' });
    const events2 = classifyFailure(checkId2, { statusCode: 502, errorMessage: 'Bad Gateway' });

    expect(events1).to.have.lengthOf(1);
    expect(events2).to.have.lengthOf(1);
    expect(events1[0].failureType).to.equal('expired_token');
    expect(events2[0].failureType).to.equal('broken_webhook');

    const entry1 = getOrCreatePlaybookEntry(db, events1[0].failureType);
    const entry2 = getOrCreatePlaybookEntry(db, events2[0].failureType);
    expect(entry1.occurrenceCount).to.equal(1);
    expect(entry2.occurrenceCount).to.equal(1);

    getOrCreatePlaybookEntry(db, 'expired_token');
    getOrCreatePlaybookEntry(db, 'broken_webhook');

    const r1 = await runRemediation(db, getOrCreatePlaybookEntry(db, 'expired_token'));
    const r2 = await runRemediation(db, getOrCreatePlaybookEntry(db, 'broken_webhook'));

    expect(r1.status).to.equal('success');
    expect(r2.status).to.equal('success');

    const { logs, count } = getRemediationLogs(db);
    expect(count).to.equal(2);

    const tokenLog = logs.find(l => l.failureType === 'expired_token');
    const webhookLog = logs.find(l => l.failureType === 'broken_webhook');
    expect(tokenLog).to.exist;
    expect(webhookLog).to.exist;
  });

  it('end-to-end: classify -> playbook -> remediate for rate_limit_shift', async () => {
    const checkId = 'e2e-rate';

    getOrCreatePlaybookEntry(db, 'rate_limit_shift');

    const events = classifyFailure(checkId, {
      statusCode: 429,
      headers: { 'x-ratelimit-remaining': '0' },
    });

    expect(events).to.have.lengthOf(1);
    expect(events[0].failureType).to.equal('rate_limit_shift');

    const entry = getOrCreatePlaybookEntry(db, 'rate_limit_shift');
    expect(entry.occurrenceCount).to.be.at.least(2);

    const result = await runRemediation(db, entry, { currentIntervalSec: 60 });
    expect(result.status).to.equal('success');
    expect(result.output).to.include('120s');
  });

  it('end-to-end: classify -> playbook -> remediate for schema_drift', async () => {
    const checkId = 'e2e-schema';

    getOrCreatePlaybookEntry(db, 'schema_drift');

    const events = classifyFailure(checkId, {
      body: { _unexpected: true },
    });

    expect(events).to.have.lengthOf(1);
    expect(events[0].failureType).to.equal('schema_drift');

    const entry = getOrCreatePlaybookEntry(db, 'schema_drift');
    expect(entry.occurrenceCount).to.be.at.least(2);

    const result = await runRemediation(db, entry, { apiEndpoint: 'https://api.example.com/v2', newSchemaVersion: 'v2' });
    expect(result.status).to.equal('failed');
  });
});