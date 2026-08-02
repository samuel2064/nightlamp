import { createDatabase } from '../db/schema';
import { PerfStorage } from '../performance/perf-storage';
import { RegressionDetector } from '../performance/regression-detector';
import { SloMonitor, SloDefinition, PHASE_3_SLOS } from '../performance/slo-monitor';
import { Database } from 'sql.js';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';

describe('SLO Monitor', () => {
  let db: Database;
  let storage: PerfStorage;
  let detector: RegressionDetector;
  let monitor: SloMonitor;

  before(async () => {
    db = await createDatabase();
    storage = new PerfStorage(db);
    detector = new RegressionDetector(storage, 0.05);
    monitor = new SloMonitor(storage, detector);
  });

  after(() => {
    if (db) db.close();
  });

  describe('Definitions', () => {
    it('should have default Lighthouse SLOs', () => {
      const defs = monitor.getDefinitions();
      assert.ok(defs.length > 0);
      const lcp = defs.find(d => d.metric === 'LCP');
      assert.ok(lcp);
      assert.strictEqual(lcp?.target, 2500);
      assert.strictEqual(lcp?.comparison, 'lt');
    });

    it('should include Phase 3 SLOs', () => {
      assert.ok(PHASE_3_SLOS.length > 0);
      const onboarding = PHASE_3_SLOS.find(s => s.metric === 'onboarding_completion');
      assert.ok(onboarding);
      assert.strictEqual(onboarding?.target, 300);
    });

    it('should each have a description', () => {
      for (const slo of monitor.getDefinitions()) {
        assert.ok(slo.description, `SLO ${slo.metric} missing description`);
      }
    });
  });

  describe('SLO Breach Detection', () => {
    it('should detect LCP breach when value exceeds target', () => {
      const breach = monitor.checkSlo('http://test.com', 'LCP', 3000);
      assert.ok(breach);
      assert.strictEqual(breach.metric, 'LCP');
      assert.strictEqual(breach.currentValue, 3000);
      assert.strictEqual(breach.target, 2500);
      assert.strictEqual(breach.acknowledged, false);
    });

    it('should not detect breach when value meets target', () => {
      const breach = monitor.checkSlo('http://test.com', 'LCP', 1500);
      assert.strictEqual(breach, null);
    });

    it('should detect score breach when value below target', () => {
      const breach = monitor.checkSlo('http://test.com', 'score', 0.6);
      assert.ok(breach);
      assert.strictEqual(breach.metric, 'score');
    });

    it('should not detect breach for unknown metric', () => {
      const breach = monitor.checkSlo('http://test.com', 'UNKNOWN', 999);
      assert.strictEqual(breach, null);
    });

    it('should return null for unknown SLO', () => {
      const result = monitor.checkSlo('http://test.com', 'nonexistent', 100);
      assert.strictEqual(result, null);
    });
  });

  describe('Lighthouse Run Check', () => {
    it('should detect breaches across all Lighthouse metrics', () => {
      const breaches = monitor.checkLighthouseRun('http://test.com', {
        lcp: 5000,
        tbt: 500,
        cls: 0.5,
        fcp: 3000,
        inp: 400,
        score: 0.4,
      });
      assert.strictEqual(breaches.length, 6);
    });

    it('should detect no breaches for good performance', () => {
      const breaches = monitor.checkLighthouseRun('http://test.com', {
        lcp: 1000,
        tbt: 50,
        cls: 0.05,
        fcp: 800,
        inp: 100,
        score: 0.95,
      });
      assert.strictEqual(breaches.length, 0);
    });

    it('should return partial breaches', () => {
      const breaches = monitor.checkLighthouseRun('http://test.com', {
        lcp: 3000,
        tbt: 100,
        cls: 0.05,
        fcp: 1500,
        inp: 150,
        score: 0.9,
      });
      assert.ok(breaches.length > 0);
      assert.ok(breaches.length < 6);
      assert.ok(breaches.every(b => b.metric === 'LCP'));
    });
  });

  describe('Breach Management', () => {
    it('should track breaches per URL', () => {
      monitor.checkSlo('http://url-a.com', 'LCP', 3000);
      monitor.checkSlo('http://url-b.com', 'TBT', 300);

      const urlABreaches = monitor.getBreaches('http://url-a.com');
      assert.ok(urlABreaches.length > 0);
      assert.ok(urlABreaches.every(b => b.url === 'http://url-a.com'));
    });

    it('should acknowledge a breach', () => {
      monitor.checkSlo('http://ack-test.com', 'LCP', 3000);
      const breaches = monitor.getBreaches('http://ack-test.com');
      assert.ok(breaches.length > 0);

      const acknowledged = monitor.acknowledgeBreach(breaches[0].id);
      assert.strictEqual(acknowledged, true);

      const updated = monitor.getBreaches('http://ack-test.com');
      assert.strictEqual(updated[0].acknowledged, true);
    });

    it('should return false for unknown breach ID', () => {
      const result = monitor.acknowledgeBreach('nonexistent-id');
      assert.strictEqual(result, false);
    });
  });

  describe('Summary', () => {
    it('should return pass when no breaches', () => {
      const summary = monitor.summarize('http://pass-test.com');
      assert.strictEqual(summary.sloPass, true);
      assert.strictEqual(summary.breaches.length, 0);
    });

    it('should return fail when breaches exist', () => {
      monitor.checkSlo('http://fail-test.com', 'LCP', 3000);
      const summary = monitor.summarize('http://fail-test.com');
      assert.strictEqual(summary.sloPass, false);
      assert.ok(summary.breaches.length > 0);
    });

    it('should report total SLO count', () => {
      const summary = monitor.summarize('http://count-test.com');
      assert.ok(summary.totalSlos > 0);
    });
  });

  describe('Error Budget', () => {
    it('should calculate error budget remaining', () => {
      const breach = monitor.checkSlo('http://budget-test.com', 'LCP', 5000);
      assert.ok(breach);
      assert.ok(breach.errorBudgetRemaining >= 0);
      assert.ok(breach.errorBudgetRemaining <= 43200);
    });
  });

  describe('Custom SLOs', () => {
    it('should accept custom SLO definitions', () => {
      const customSlos: SloDefinition[] = [
        { metric: 'custom_metric', target: 100, unit: 'ms', comparison: 'lt', description: 'Custom', errorBudgetMinutes: 60 },
      ];
      const customMonitor = new SloMonitor(storage, detector, customSlos);
      const defs = customMonitor.getDefinitions();
      assert.strictEqual(defs.length, 1);
      assert.strictEqual(defs[0].metric, 'custom_metric');

      const breach = customMonitor.checkSlo('http://test.com', 'custom_metric', 200);
      assert.ok(breach);
    });
  });
});
