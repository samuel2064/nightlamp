import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { TimingStat } from '../performance/api-latency';
import { evaluateAndNotify } from './evaluator';
import { getPolicyForSeverity } from './escalation';

/**
 * Self-monitoring SLO evaluator.
 *
 * Nightlamp monitors its own production health. This module turns real-time
 * metrics into SLI/SLO status against a fixed set of production objectives:
 *
 *   - error rate must stay <= 1% over the window
 *   - API p95 latency must stay < 500ms
 *   - unavailability (downtime) must stay < 1 minute
 *
 * Each SLO keeps a rolling breached-window. When a metric crosses its target it
 * produces a failure event and routes through the standard alert evaluator, so
 * existing escalation policies (P1/P2/P3) and notification channels apply.
 */

export interface SelfMonitorSlo {
  key: string;
  label: string;
  target: number;
  unit: string;
  comparison: 'lt' | 'gt' | 'lte';
  currentValue: number;
  breached: boolean;
  windowHours: number;
}

export interface SelfMonitorInput {
  // Fraction of failures contributing to errors (0..1) over the window.
  errorRate: number;
  // Global p95 latency in ms over the window.
  p95LatencyMs: number;
  // Accumulated downtime in seconds over the window.
  downtimeSeconds: number;
  windowHours: number;
}

export const SELF_MONITOR_DEFAULTS = {
  // Error rate must stay <= 1%.
  maxErrorRate: 0.01,
  // API p95 latency must stay < 500ms.
  maxP95LatencyMs: 500,
  // Downtime must stay below 1 minute.
  maxDowntimeSeconds: 60,
  windowHours: 24,
};

export const SELF_SOURCE = 'self-monitor';

export interface SelfMonitorResult {
  windowHours: number;
  slos: SelfMonitorSlo[];
  overall: 'ok' | 'degraded' | 'critical';
  anyBreached: boolean;
}

function makeSlo(
  key: string,
  label: string,
  target: number,
  unit: string,
  comparison: SelfMonitorSlo['comparison'],
  currentValue: number,
  windowHours: number
): SelfMonitorSlo {
  const breached = comparison === 'lt'
    ? currentValue >= target
    : currentValue > target;
  return { key, label, target, unit, comparison, currentValue, breached, windowHours };
}

/** Evaluate the supplied metrics against the production SLO thresholds. */
export function evaluateSelfMonitorSlo(
  input: SelfMonitorInput,
  thresholds: Partial<Pick<typeof SELF_MONITOR_DEFAULTS, 'maxErrorRate' | 'maxP95LatencyMs' | 'maxDowntimeSeconds'>> = {}
): SelfMonitorResult {
  const {
    maxErrorRate = SELF_MONITOR_DEFAULTS.maxErrorRate,
    maxP95LatencyMs = SELF_MONITOR_DEFAULTS.maxP95LatencyMs,
    maxDowntimeSeconds = SELF_MONITOR_DEFAULTS.maxDowntimeSeconds,
  } = thresholds;

  const slos: SelfMonitorSlo[] = [
    makeSlo('error_rate', 'Error rate', maxErrorRate, '%', 'lte', input.errorRate, input.windowHours),
    makeSlo('latency_p95', 'API p95 latency', maxP95LatencyMs, 'ms', 'lt', input.p95LatencyMs, input.windowHours),
    makeSlo('downtime', 'Downtime', maxDowntimeSeconds, 's', 'lte', input.downtimeSeconds, input.windowHours),
  ];

  const breachedCount = slos.filter((s) => s.breached).length;

  let overall: SelfMonitorResult['overall'];
  if (breachedCount === 0) overall = 'ok';
  else if (breachedCount === 1) overall = 'degraded';
  else overall = 'critical';

  return { windowHours: input.windowHours, slos, overall, anyBreached: breachedCount > 0 };
}

/**
 * Severity label for a self-monitor breach, used to drive escalation priority
 * and alert rules. Multiple simultaneous breaches are always critical.
 */
export function severityForResult(result: SelfMonitorResult): string {
  if (result.overall === 'ok') return 'info';
  return result.overall === 'critical' ? 'critical' : 'warning';
}

/**
 * Build the self-monitor input from persisted data:
 *  - errorRate from recent "failed" check_results as a fraction of all recent check_results
 *  - downtime seconds from contiguous failed check_results within the window
 *  - p95LatencyMs from the supplied latency summary (global p95)
 */
export function readSelfMonitorMetrics(
  db: Database,
  latencySummary: { global: TimingStat },
  windowHours: number = SELF_MONITOR_DEFAULTS.windowHours
): SelfMonitorInput {
  const results = db.exec(
    `SELECT status, executed_at FROM check_results`
  );

  let total = 0;
  let failed = 0;
  let latestFailed: Date | null = null;
  let earliestFailed: Date | null = null;

  if (results.length > 0) {
    total = results[0].values.length;
    for (const row of results[0].values) {
      const status = row[0] as string;
      const ts = new Date((row[1] as string).replace(' ', 'T') + 'Z');
      if (status === 'failed' || status === 'down') {
        failed += 1;
        if (!latestFailed || ts > latestFailed) latestFailed = ts;
        if (!earliestFailed || ts < earliestFailed) earliestFailed = ts;
      }
    }
  }

  let errorRate = 0;
  if (total > 0) errorRate = failed / total;

  let downtimeSeconds = 0;
  if (earliestFailed && latestFailed) {
    downtimeSeconds = Math.max(0, (latestFailed.getTime() - earliestFailed.getTime()) / 1000);
  }

  return {
    errorRate,
    p95LatencyMs: latencySummary.global.p95 || 0,
    downtimeSeconds,
    windowHours,
  };
}

/**
 * Evaluate Nightlamp's own health from the live database, recording any breach
 * as a failure event and dispatching it through the alert evaluator. Returns
 * the full evaluation so it can be surfaced on a dashboard.
 */
export async function evaluateSelfMonitor(
  db: Database,
  latencySummary: { global: TimingStat },
  opts: {
    persist?: boolean;
    checkId?: string;
    windowHours?: number;
  } = {}
): Promise<SelfMonitorResult> {
  const windowHours = opts.windowHours ?? SELF_MONITOR_DEFAULTS.windowHours;
  const input = readSelfMonitorMetrics(db, latencySummary, windowHours);
  const result = evaluateSelfMonitorSlo(input);

  if (opts.persist !== false && result.anyBreached) {
    const checkId = opts.checkId || 'self-monitor-1';
    const severity = severityForResult(result);
    const violated = result.slos.filter((s) => s.breached).map((s) => `${s.label}: current ${formatValue(s.currentValue, s.unit)}, target ${s.comparison.toUpperCase()} ${formatValue(s.target, s.unit)}`);

    const eventId = uuidv4();
    db.run(
      `INSERT INTO failure_events (id, check_id, failure_type, severity, title, description, detected_at)
       VALUES (?, ?, 'slo_breach', ?, ?, ?, datetime('now'))`,
      [eventId, checkId, severityForResult(result), `Nightlamp self-monitor breach (${result.slos.filter((s) => s.breached).map((s) => s.key).join(', ')})`, `Self-monitoring SLO breach detected.\n${violated.join('\n')}`]
    );

    await evaluateAndNotify(
      db,
      'slo_breach',
      severityForResult(result),
      `Nightlamp self-monitor breach (${result.overall})`,
      `Self-monitoring detected a production SLO breach.\n${violated.join('\n')}`,
      new Date().toISOString(),
      checkId,
      eventId
    );
  }

  return result;
}

/**
 * Real-time SLO dashboard payload assembled from the current process metrics.
 */
export function buildSelfMonitorDashboard(
  db: Database,
  latencySummary: { global: TimingStat },
  windowHours: number = SELF_MONITOR_DEFAULTS.windowHours
): { result: SelfMonitorResult; thresholds: typeof SELF_MONITOR_DEFAULTS } {
  const input = readSelfMonitorMetrics(db, latencySummary, windowHours);
  return {
    result: evaluateSelfMonitorSlo(input),
    thresholds: SELF_MONITOR_DEFAULTS,
  };
}

function formatValue(value: number, unit: string): string {
  if (unit === 'error') return (value * 100).toFixed(2) + '%';
  if (unit === 'ms') return Math.round(value).toString() + 'ms';
  if (unit === 's') return Math.round(value).toString() + 's';
  return value.toString();
}