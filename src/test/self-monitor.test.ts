import assert from 'assert';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import {
  SELF_MONITOR_DEFAULTS,
  evaluateSelfMonitorSlo,
  readSelfMonitorMetrics,
  severityForResult,
} from '../alerting';

describe('Alerting Self-Monitor SLO', function () {
  it('reports ok when all metrics are within targets', function () {
    const result = evaluateSelfMonitorSlo({
      errorRate: 0.005,
      p95LatencyMs: 200,
      downtimeSeconds: 10,
      windowHours: 24,
    });
    assert.strictEqual(result.overall, 'ok');
    assert.strictEqual(result.anyBreached, false);
    assert.strictEqual(result.slos.length, 3);
  });

  it('breaches error_rate when it exceeds 1%', function () {
    const result = evaluateSelfMonitorSlo({
      errorRate: 0.02,
      p95LatencyMs: 50,
      downtimeSeconds: 0,
      windowHours: 24,
    });
    const errorSlo = result.slos.find((s) => s.key === 'error_rate');
    assert.ok(errorSlo);
    assert.strictEqual(errorSlo!.breached, true);
    assert.strictEqual(result.overall, 'degraded');
  });

  it('breaches p95 latency when it equals/exceeds 500ms', function () {
    const result = evaluateSelfMonitorSlo({
      errorRate: 0.001,
      p95LatencyMs: 500,
      downtimeSeconds: 0,
      windowHours: 24,
    });
    const latencySlo = result.slos.find((s) => s.key === 'latency_p95');
    assert.strictEqual(latencySlo!.breached, true);
  });

  it('breaches downtime when it exceeds 60 seconds', function () {
    const result = evaluateSelfMonitorSlo({
      errorRate: 0.001,
      p95LatencyMs: 50,
      downtimeSeconds: 120,
      windowHours: 24,
    });
    const downtimeSlo = result.slos.find((s) => s.key === 'downtime');
    assert.strictEqual(downtimeSlo!.breached, true);
  });

  it('escalates to critical when multiple SLOs breach', function () {
    const result = evaluateSelfMonitorSlo({
      errorRate: 0.05,
      p95LatencyMs: 800,
      downtimeSeconds: 300,
      windowHours: 24,
    });
    assert.strictEqual(result.overall, 'critical');
    assert.strictEqual(severityForResult(result), 'critical');
  });

  it('maps degraded to warning and ok to info severity', function () {
    const ok = evaluateSelfMonitorSlo({ errorRate: 0, p95LatencyMs: 10, downtimeSeconds: 0, windowHours: 24 });
    assert.strictEqual(severityForResult(ok), 'info');
    const degraded = evaluateSelfMonitorSlo({ errorRate: 0.05, p95LatencyMs: 20, downtimeSeconds: 0, windowHours: 24 });
    assert.strictEqual(severityForResult(degraded), 'warning');
  });

  it('computes error rate and downtime from persisted check results', async function () {
    const db = await createDatabase();
    db.run('INSERT INTO check_results (id, check_id, status, summary, executed_at) VALUES (?, ?, ?, ?, ?)',
      ['sm-1', 'c1', 'pass', 'ok', '2026-08-02 10:00:00']);
    db.run('INSERT INTO check_results (id, check_id, status, summary, executed_at) VALUES (?, ?, ?, ?, ?)',
      ['sm-2', 'c1', 'pass', 'ok', '2026-08-02 10:01:00']);
    db.run('INSERT INTO check_results (id, check_id, status, summary, executed_at) VALUES (?, ?, ?, ?, ?)',
      ['sm-3', 'c1', 'failed', 'down', '2026-08-02 10:02:00']);
    db.run('INSERT INTO check_results (id, check_id, status, summary, executed_at) VALUES (?, ?, ?, ?, ?)',
      ['sm-4', 'c1', 'failed', 'down', '2026-08-02 10:04:00']);

    const input = readSelfMonitorMetrics(db, { global: { count: 4, p50: 0, p95: 30, p99: 0, max: 0, avg: 0 } }, 24);
    assert.strictEqual(input.errorRate, 0.5);
    assert.strictEqual(input.downtimeSeconds, 120);
    assert.strictEqual(input.p95LatencyMs, 30);

    const result = evaluateSelfMonitorSlo(input);
    assert.strictEqual(result.overall, 'critical');
    db.close();
  });

  it('exposes the configured production thresholds', function () {
    assert.strictEqual(SELF_MONITOR_DEFAULTS.maxErrorRate, 0.01);
    assert.strictEqual(SELF_MONITOR_DEFAULTS.maxP95LatencyMs, 500);
    assert.strictEqual(SELF_MONITOR_DEFAULTS.maxDowntimeSeconds, 60);
  });
});