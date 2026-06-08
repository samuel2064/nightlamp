import { PerfStorage, PerfRun } from './perf-storage';

export class RegressionDetector {
  private readonly pValueThreshold: number;

  constructor(private storage: PerfStorage, threshold: number = 0.05) {
    this.pValueThreshold = threshold;
  }

  analyzeRuns(url: string, currentRun: PerfRun): { detected: boolean; regressions: any[] } {
    const metrics: { name: string; value: number }[] = [
      { name: 'LCP', value: currentRun.lcp },
      { name: 'TBT', value: currentRun.tbt },
      { name: 'CLS', value: currentRun.cls },
      { name: 'FCP', value: currentRun.fcp },
      { name: 'INP', value: currentRun.inp },
      { name: 'score', value: currentRun.score },
    ];

    const regressions: any[] = [];

    for (const metric of metrics) {
      const baseline = this.storage.getBaseline(url, metric.name);

      if (baseline.count < 2) continue;

      const zScore = baseline.stddev > 0
        ? Math.abs((metric.value - baseline.mean) / baseline.stddev)
        : 0;

      const pValue = 2 * (1 - this.normalCDF(zScore));

      if (pValue < this.pValueThreshold) {
        const isDegradation = (metric.name === 'score')
          ? metric.value < baseline.mean
          : metric.value > baseline.mean;

        if (isDegradation) {
          const regId = this.storage.storeRegression({
            metric: metric.name,
            currentValue: metric.value,
            baselineMean: baseline.mean,
            baselineStddev: baseline.stddev,
            pValue,
            direction: 'degradation',
            url,
            runId: currentRun.id,
          });

          regressions.push({
            id: regId,
            metric: metric.name,
            currentValue: metric.value,
            baselineMean: baseline.mean,
            pValue,
            direction: 'degradation',
          });
        }
      }
    }

    return { detected: regressions.length > 0, regressions };
  }

  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1 / (1 + p * x);
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1 + sign * y);
  }
}