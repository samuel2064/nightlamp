import { expect } from 'chai';
import initSqlJs, { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { PerfStorage } from '../performance/perf-storage';
import { RegressionDetector } from '../performance/regression-detector';
import { PerfDiagnosis } from '../performance/perf-diagnosis';

describe('Performance - Storage', () => {
  let db: Database;
  let storage: PerfStorage;

  beforeEach(async () => {
    db = await createDatabase();
    storage = new PerfStorage(db);
  });

  it('creates a performance run', () => {
    const id = storage.createRun('https://example.com');
    expect(id).to.be.a('string');

    const runs = storage.getRecentRuns('https://example.com');
    expect(runs).to.have.length(1);
    expect(runs[0].status).to.equal('pending');
  });

  it('completes a run successfully', () => {
    const id = storage.createRun('https://example.com');
    storage.completeRun(id, {
      url: 'https://example.com',
      lcp: 1500, tbt: 200, cls: 0.1, fcp: 800, inp: 100, score: 85,
      rawJson: '{}', successful: true,
    });

    const runs = storage.getRecentRuns('https://example.com');
    expect(runs[0].status).to.equal('completed');
    expect(runs[0].lcp).to.equal(1500);
    expect(runs[0].score).to.equal(85);
  });

  it('marks run as failed', () => {
    const id = storage.createRun('https://example.com');
    storage.completeRun(id, {
      url: 'https://example.com', lcp: 0, tbt: 0, cls: 0, fcp: 0, inp: 0, score: 0,
      rawJson: '', successful: false, error: 'Timeout',
    });

    const runs = storage.getRecentRuns('https://example.com');
    expect(runs[0].status).to.equal('failed');
  });

  it('stores and retrieves metric history', () => {
    const id1 = storage.createRun('https://example.com');
    storage.completeRun(id1, {
      url: 'https://example.com', lcp: 1000, tbt: 150, cls: 0.1, fcp: 600, inp: 80, score: 90,
      rawJson: '{}', successful: true,
    });

    const id2 = storage.createRun('https://example.com');
    storage.completeRun(id2, {
      url: 'https://example.com', lcp: 1200, tbt: 180, cls: 0.12, fcp: 700, inp: 90, score: 85,
      rawJson: '{}', successful: true,
    });

    const history = storage.getMetricHistory('https://example.com', 'LCP', 10);
    expect(history).to.have.length(2);
    const values = history.map(h => h.value).sort();
    expect(values[0]).to.equal(1000);
    expect(values[1]).to.equal(1200);
  });

  it('calculates baseline stats', () => {
    const url = 'https://example.com';
    for (const lcp of [1000, 1100, 1050, 950]) {
      const id = storage.createRun(url);
      storage.completeRun(id, {
        url, lcp, tbt: 150, cls: 0.1, fcp: 600, inp: 80, score: 90,
        rawJson: '{}', successful: true,
      });
    }

    const baseline = storage.getBaseline(url, 'LCP', 10);
    expect(baseline.count).to.equal(4);
    expect(baseline.mean).to.be.closeTo(1025, 50);
    expect(baseline.stddev).to.be.greaterThan(0);
  });

  it('stores and retrieves regressions', () => {
    storage.storeRegression({
      metric: 'LCP', currentValue: 3000, baselineMean: 1000, baselineStddev: 100,
      pValue: 0.001, direction: 'degradation', url: 'https://example.com', runId: 'run-1',
    });

    const regs = storage.getRegressions();
    expect(regs).to.have.length(1);
    expect(regs[0].metric).to.equal('LCP');
    expect(regs[0].pValue).to.be.lessThan(0.05);
  });

  it('stores and retrieves diagnoses', () => {
    const regId = storage.storeRegression({
      metric: 'LCP', currentValue: 3000, baselineMean: 1000, baselineStddev: 100,
      pValue: 0.001, direction: 'degradation', url: 'https://example.com', runId: 'run-1',
    });

    storage.storeDiagnosis({
      regressionId: regId,
      diagnosis: 'LCP degraded',
      recommendation: 'Optimize images',
      impact: 'high',
      category: 'loading',
    });

    const diagnoses = storage.getDiagnoses(regId);
    expect(diagnoses).to.have.length(1);
    expect(diagnoses[0].diagnosis).to.equal('LCP degraded');
  });
});

describe('Performance - Regression Detector', () => {
  let db: Database;
  let storage: PerfStorage;
  let detector: RegressionDetector;

  beforeEach(async () => {
    db = await createDatabase();
    storage = new PerfStorage(db);
    detector = new RegressionDetector(storage, 0.05);

    const url = 'https://example.com';
    for (const lcp of [1000, 1050, 950, 1100]) {
      const id = storage.createRun(url);
      storage.completeRun(id, {
        url, lcp, tbt: 150, cls: 0.1, fcp: 600, inp: 80, score: 90,
        rawJson: '{}', successful: true,
      });
    }
  });

  it('detects no regression when value is within baseline', () => {
    const runs = storage.getRecentRuns('https://example.com', 1);
    runs[0].lcp = 1050;

    const result = detector.analyzeRuns('https://example.com', runs[0]);
    expect(result.detected).to.be.false;
  });

  it('detects regression when value far from baseline', () => {
    const runs = storage.getRecentRuns('https://example.com', 1);
    runs[0].lcp = 3000;

    const result = detector.analyzeRuns('https://example.com', runs[0]);
    expect(result.detected).to.be.true;
    expect(result.regressions[0].metric).to.equal('LCP');
  });

  it('registers regression with p-value < 0.05', () => {
    const runs = storage.getRecentRuns('https://example.com', 1);
    runs[0].lcp = 3000;

    const result = detector.analyzeRuns('https://example.com', runs[0]);
    expect(result.regressions[0].pValue).to.be.lessThan(0.05);
  });
});

describe('Performance - Diagnosis', () => {
  let db: Database;
  let storage: PerfStorage;
  let diagnosis: PerfDiagnosis;

  beforeEach(async () => {
    db = await createDatabase();
    storage = new PerfStorage(db);
    diagnosis = new PerfDiagnosis(storage);
  });

  it('diagnoses LCP regression', () => {
    const results = diagnosis.diagnose('https://example.com', { metric: 'LCP', id: 'reg-1' });
    expect(results).to.have.length(1);
    expect(results[0].category).to.equal('loading');
    expect(results[0].impact).to.equal('high');
  });

  it('diagnoses TBT regression', () => {
    const results = diagnosis.diagnose('https://example.com', { metric: 'TBT', id: 'reg-2' });
    expect(results[0].category).to.equal('interactivity');
  });

  it('diagnoses CLS regression', () => {
    const results = diagnosis.diagnose('https://example.com', { metric: 'CLS', id: 'reg-3' });
    expect(results[0].category).to.equal('visual-stability');
  });

  it('stores diagnoses in database', () => {
    diagnosis.diagnose('https://example.com', { metric: 'FCP', id: 'reg-4' });
    const stored = storage.getDiagnoses('reg-4');
    expect(stored).to.have.length(1);
  });
});