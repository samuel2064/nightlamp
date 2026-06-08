import { Database } from 'sql.js';
import { v4 as uuid } from 'uuid';
import { LighthouseResult } from './lighthouse-runner';

export interface PerfRun {
  id: string;
  url: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  lcp: number;
  tbt: number;
  cls: number;
  fcp: number;
  inp: number;
  score: number;
  startedAt: string;
  completedAt: string | null;
}

export class PerfStorage {
  constructor(private db: Database) {}

  createRun(url: string): string {
    const id = uuid();
    this.db.run(
      'INSERT INTO perf_runs (id, url) VALUES (?, ?)',
      [id, url],
    );
    return id;
  }

  completeRun(runId: string, result: LighthouseResult): void {
    if (result.successful) {
      this.db.run(
        `UPDATE perf_runs SET status = 'completed', lcp = ?, tbt = ?, cls = ?, fcp = ?, inp = ?, score = ?, raw_output = ?, completed_at = datetime('now') WHERE id = ?`,
        [result.lcp, result.tbt, result.cls, result.fcp, result.inp, result.score, result.rawJson, runId],
      );

      this.storeMetrics(runId, result);
    } else {
      this.db.run(
        `UPDATE perf_runs SET status = 'failed', raw_output = ?, completed_at = datetime('now') WHERE id = ?`,
        [result.error || '', runId],
      );
    }
  }

  private storeMetrics(runId: string, result: LighthouseResult): void {
    const metrics: { name: string; value: number; unit: string }[] = [
      { name: 'LCP', value: result.lcp, unit: 'ms' },
      { name: 'TBT', value: result.tbt, unit: 'ms' },
      { name: 'CLS', value: result.cls, unit: '' },
      { name: 'FCP', value: result.fcp, unit: 'ms' },
      { name: 'INP', value: result.inp, unit: 'ms' },
      { name: 'score', value: result.score, unit: 'score' },
    ];

    for (const m of metrics) {
      this.db.run(
        'INSERT INTO perf_metrics (id, run_id, name, value, unit) VALUES (?, ?, ?, ?, ?)',
        [uuid(), runId, m.name, m.value, m.unit],
      );
    }
  }

  getRecentRuns(url: string, limit: number = 10): PerfRun[] {
    const result = this.db.exec(
      `SELECT id, url, status, lcp, tbt, cls, fcp, inp, score, started_at, completed_at FROM perf_runs WHERE url = ? ORDER BY started_at DESC LIMIT ?`,
      [url, limit],
    );

    if (result.length === 0) return [];

    return result[0].values.map((row: any) => ({
      id: row[0] as string,
      url: row[1] as string,
      status: row[2] as PerfRun['status'],
      lcp: row[3] as number,
      tbt: row[4] as number,
      cls: row[5] as number,
      fcp: row[6] as number,
      inp: row[7] as number,
      score: row[8] as number,
      startedAt: row[9] as string,
      completedAt: row[10] as string | null,
    }));
  }

  getMetricHistory(url: string, metric: string, limit: number = 24): { value: number; date: string }[] {
    const result = this.db.exec(
      `SELECT pm.value, pr.started_at
       FROM perf_metrics pm
       JOIN perf_runs pr ON pm.run_id = pr.id
       WHERE pr.url = ? AND pm.name = ? AND pr.status = 'completed'
       ORDER BY pr.started_at DESC LIMIT ?`,
      [url, metric, limit],
    );

    if (result.length === 0) return [];

    return result[0].values.map((row: any) => ({
      value: row[0] as number,
      date: row[1] as string,
    }));
  }

  getBaseline(url: string, metric: string, lookback: number = 4): { mean: number; stddev: number; count: number } {
    const history = this.getMetricHistory(url, metric, lookback);

    if (history.length < 2) {
      return { mean: 0, stddev: 0, count: history.length };
    }

    const values = history.map(h => h.value);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
    const stddev = Math.sqrt(variance);

    return { mean, stddev, count: values.length };
  }

  storeRegression(regression: {
    metric: string;
    currentValue: number;
    baselineMean: number;
    baselineStddev: number;
    pValue: number;
    direction: string;
    url: string;
    runId: string;
  }): string {
    const id = uuid();
    const trend = regression.direction === 'degradation' ? 'declining' : 'improving';
    this.db.run(
      `INSERT INTO perf_regressions (id, metric, current_value, baseline_mean, baseline_stddev, p_value, direction, trend, url, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, regression.metric, regression.currentValue, regression.baselineMean, regression.baselineStddev, regression.pValue, regression.direction, trend, regression.url, regression.runId],
    );
    return id;
  }

  getRegressions(url?: string, limit: number = 20): any[] {
    let sql = `SELECT pr.id, pr.metric, pr.current_value, pr.baseline_mean, pr.baseline_stddev, pr.p_value, pr.direction, pr.trend, pr.url, pr.detected_at, pr.acknowledged FROM perf_regressions pr`;
    const params: any[] = [];

    if (url) {
      sql += ' WHERE pr.url = ?';
      params.push(url);
    }

    sql += ' ORDER BY pr.detected_at DESC LIMIT ?';
    params.push(limit);

    const result = this.db.exec(sql, params);
    if (result.length === 0) return [];

    return result[0].values.map((row: any) => ({
      id: row[0], metric: row[1], currentValue: row[2], baselineMean: row[3],
      baselineStddev: row[4], pValue: row[5], direction: row[6], trend: row[7],
      url: row[8], detectedAt: row[9], acknowledged: row[10] === 1,
    }));
  }

  storeDiagnosis(diagnosis: {
    regressionId: string;
    diagnosis: string;
    recommendation: string;
    impact: string;
    category: string;
  }): string {
    const id = uuid();
    this.db.run(
      'INSERT INTO perf_diagnoses (id, regression_id, diagnosis, recommendation, impact, category) VALUES (?, ?, ?, ?, ?, ?)',
      [id, diagnosis.regressionId, diagnosis.diagnosis, diagnosis.recommendation, diagnosis.impact, diagnosis.category],
    );
    return id;
  }

  getDiagnoses(regressionId: string): any[] {
    const result = this.db.exec(
      'SELECT id, diagnosis, recommendation, impact, category, created_at FROM perf_diagnoses WHERE regression_id = ? ORDER BY created_at DESC',
      [regressionId],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any) => ({
      id: row[0], diagnosis: row[1], recommendation: row[2],
      impact: row[3], category: row[4], createdAt: row[5],
    }));
  }
}