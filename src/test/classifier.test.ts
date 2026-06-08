import { classifyFailure } from '../classifier';
import assert from 'assert';

describe('Failure Classifier', () => {
  it('should classify expired token (401)', () => {
    const events = classifyFailure('test', { statusCode: 401, errorMessage: 'expired token' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'expired_token');
    assert.strictEqual(events[0].severity, 'critical');
  });

  it('should classify expired token (403)', () => {
    const events = classifyFailure('test', { statusCode: 403, errorMessage: 'unauthorized' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'expired_token');
  });

  it('should classify rate limit shift (429)', () => {
    const events = classifyFailure('test', { statusCode: 429, headers: { 'x-ratelimit-remaining': '0' } });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'rate_limit_shift');
    assert.strictEqual(events[0].severity, 'warning');
  });

  it('should classify broken webhook (5xx)', () => {
    const events = classifyFailure('test', { statusCode: 502, errorMessage: 'Bad Gateway' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'broken_webhook');
    assert.strictEqual(events[0].severity, 'critical');
  });

  it('should classify schema drift from empty body', () => {
    const events = classifyFailure('test', { body: {} });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'schema_drift');
  });

  it('should combine expired_token + schema_drift for 403 with body', () => {
    const events = classifyFailure('test', { statusCode: 403, errorMessage: 'token expired', body: { _weird: true } });
    assert.strictEqual(events.length, 2);
    const types = events.map(e => e.failureType).sort();
    assert.deepStrictEqual(types, ['expired_token', 'schema_drift']);
  });

  it('should classify 401 without auth keywords as broken_webhook catch-all', () => {
    const events = classifyFailure('test', { statusCode: 401, errorMessage: 'rate limit exceeded' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'broken_webhook');
  });

  it('should return empty for normal 200 response', () => {
    const events = classifyFailure('test', { statusCode: 200, body: { ok: true } });
    assert.strictEqual(events.length, 0);
  });

  it('should classify 4xx without specific pattern as broken_webhook warning', () => {
    const events = classifyFailure('test', { statusCode: 404, errorMessage: 'not found' });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].failureType, 'broken_webhook');
    assert.strictEqual(events[0].severity, 'warning');
  });
});