import { expect } from 'chai';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { getOrCreatePlaybookEntry } from '../playbook';
import { runRemediation, getRemediationLogs, getScriptForFailureType, RemediationLogEntry } from '../remediation/engine';
import { remediateWebhookRestart } from '../remediation/scripts/webhook-restart';
import { remediateTokenRefresh } from '../remediation/scripts/token-refresh';
import { remediateSchemaMigrate } from '../remediation/scripts/schema-migrate';
import { remediateRateLimitBackoff } from '../remediation/scripts/rate-limit-backoff';
import { FailureType } from '../classifier';

describe('Remediation - Script Mapping', () => {
  it('maps broken_webhook to webhook-restart', () => {
    expect(getScriptForFailureType('broken_webhook')).to.equal('webhook-restart');
  });

  it('maps expired_token to token-refresh', () => {
    expect(getScriptForFailureType('expired_token')).to.equal('token-refresh');
  });

  it('maps schema_drift to schema-migrate', () => {
    expect(getScriptForFailureType('schema_drift')).to.equal('schema-migrate');
  });

  it('maps rate_limit_shift to rate-limit-backoff', () => {
    expect(getScriptForFailureType('rate_limit_shift')).to.equal('rate-limit-backoff');
  });

  it('maps error_spike to webhook-restart', () => {
    expect(getScriptForFailureType('error_spike')).to.equal('webhook-restart');
  });

  it('maps new_error_pattern to webhook-restart', () => {
    expect(getScriptForFailureType('new_error_pattern')).to.equal('webhook-restart');
  });
});

describe('Remediation - Scripts', () => {
  it('webhook-restart returns success for simulated mode', async () => {
    const result = await remediateWebhookRestart();
    expect(result.success).to.be.true;
    expect(result.output).to.include('Simulated webhook restart');
  });

  it('webhook-restart handles unreachable URL gracefully', async () => {
    const result = await remediateWebhookRestart('http://localhost:1/nonexistent');
    expect(result.success).to.be.false;
    expect(result.output).to.include('unreachable');
  });

  it('token-refresh returns success for simulated mode', async () => {
    const result = await remediateTokenRefresh();
    expect(result.success).to.be.true;
    expect(result.output).to.include('Simulated token refresh');
  });

  it('token-refresh handles failed endpoint gracefully', async () => {
    const result = await remediateTokenRefresh('http://localhost:1/token', 'test', 'secret');
    expect(result.success).to.be.false;
  });

  it('schema-migrate returns success for simulated mode', async () => {
    const result = await remediateSchemaMigrate();
    expect(result.success).to.be.true;
    expect(result.output).to.include('Simulated schema migration');
  });

  it('schema-migrate handles failed endpoint gracefully', async () => {
    const result = await remediateSchemaMigrate('http://localhost:1/migrate', 'v2');
    expect(result.success).to.be.false;
  });

  it('rate-limit-backoff calculates new interval', async () => {
    const result = await remediateRateLimitBackoff(30);
    expect(result.success).to.be.true;
    expect(result.output).to.include('60s');
  });

  it('rate-limit-backoff caps at 3600s', async () => {
    const result = await remediateRateLimitBackoff(1800);
    expect(result.success).to.be.true;
    expect(result.output).to.include('3600s');
  });

  it('rate-limit-backoff defaults to 60s interval', async () => {
    const result = await remediateRateLimitBackoff();
    expect(result.success).to.be.true;
    expect(result.output).to.include('120s');
  });
});

describe('Remediation - Engine', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
  });

  it('runs remediation for expired_token', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'expired_token');
    const result = await runRemediation(db, entry);
    expect(result.status).to.equal('success');
    expect(result.logId).to.be.a('string');
    expect(result.output).to.include('Simulated token refresh');
  });

  it('runs remediation for broken_webhook', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'broken_webhook');
    const result = await runRemediation(db, entry);
    expect(result.status).to.equal('success');
  });

  it('runs remediation for schema_drift', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'schema_drift');
    const result = await runRemediation(db, entry);
    expect(result.status).to.equal('success');
  });

  it('runs remediation for rate_limit_shift', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'rate_limit_shift');
    const result = await runRemediation(db, entry);
    expect(result.status).to.equal('success');
  });

  it('runs remediation for error_spike', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'error_spike');
    const result = await runRemediation(db, entry);
    expect(result.status).to.equal('success');
  });

  it('logs remediation to database', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'expired_token');
    await runRemediation(db, entry);

    const { logs, count } = getRemediationLogs(db);
    expect(count).to.equal(1);
    expect(logs[0].failureType).to.equal('expired_token');
    expect(logs[0].script).to.equal('token-refresh');
    expect(logs[0].status).to.equal('success');
    expect(logs[0].playbookEntryId).to.equal(entry.id);
  });

  it('lists multiple remediation logs', async () => {
    const e1 = getOrCreatePlaybookEntry(db, 'expired_token');
    const e2 = getOrCreatePlaybookEntry(db, 'rate_limit_shift');
    await runRemediation(db, e1);
    await runRemediation(db, e2);

    const { logs, count } = getRemediationLogs(db);
    expect(count).to.equal(2);
  });

  it('filters remediation logs by failure type', async () => {
    const e1 = getOrCreatePlaybookEntry(db, 'expired_token');
    const e2 = getOrCreatePlaybookEntry(db, 'rate_limit_shift');
    await runRemediation(db, e1);
    await runRemediation(db, e2);

    const { logs, count } = getRemediationLogs(db, 50, 0, 'expired_token');
    expect(count).to.equal(1);
    expect(logs[0].failureType).to.equal('expired_token');
  });

  it('returns empty logs when none exist', () => {
    const { logs, count } = getRemediationLogs(db);
    expect(count).to.equal(0);
    expect(logs).to.have.lengthOf(0);
  });

  it('supports pagination', async () => {
    for (let i = 0; i < 5; i++) {
      const entry = getOrCreatePlaybookEntry(db, 'expired_token');
      await runRemediation(db, entry);
    }

    const page1 = getRemediationLogs(db, 2, 0);
    expect(page1.logs).to.have.lengthOf(2);
    expect(page1.count).to.equal(5);

    const page2 = getRemediationLogs(db, 2, 2);
    expect(page2.logs).to.have.lengthOf(2);
  });
});

describe('Remediation - Integration', () => {
  let db: Database;

  beforeEach(async () => {
    db = await createDatabase();
  });

  it('creates playbook entry, runs remediation, and logs it', async () => {
    const entry = getOrCreatePlaybookEntry(db, 'expired_token');
    expect(entry.occurrenceCount).to.equal(1);

    const result = await runRemediation(db, entry, {
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'test-client',
      clientSecret: 'test-secret',
    });

    expect(result.status).to.equal('failed');

    const { logs } = getRemediationLogs(db);
    expect(logs).to.have.lengthOf(1);
    expect(logs[0].status).to.equal('failed');
  });

  it('handles all failure types via runRemediation', async () => {
    const types: FailureType[] = ['broken_webhook', 'expired_token', 'schema_drift', 'rate_limit_shift', 'error_spike', 'new_error_pattern'];

    for (const ft of types) {
      const entry = getOrCreatePlaybookEntry(db, ft);
      const result = await runRemediation(db, entry);
      expect(result.status).to.equal('success', `Expected success for ${ft}, got ${result.status}: ${result.output}`);
      expect(result.logId).to.be.a('string');
    }

    const { logs, count } = getRemediationLogs(db);
    expect(count).to.equal(types.length);
  });
});