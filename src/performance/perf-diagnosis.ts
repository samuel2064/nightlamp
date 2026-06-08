import { PerfStorage } from './perf-storage';

export class PerfDiagnosis {
  constructor(private storage: PerfStorage) {}

  diagnose(url: string, regression: any): { diagnosis: string; recommendation: string; impact: string; category: string }[] {
    const results: { diagnosis: string; recommendation: string; impact: string; category: string }[] = [];

    switch (regression.metric) {
      case 'LCP':
        results.push({
          diagnosis: 'Largest Contentful Paint degraded — page loading slower',
          recommendation: 'Optimize images, reduce server response time, eliminate render-blocking resources',
          impact: 'high',
          category: 'loading',
        });
        break;

      case 'TBT':
        results.push({
          diagnosis: 'Total Blocking Time increased — main thread contention',
          recommendation: 'Break up long tasks, optimize third-party scripts, defer non-critical JS',
          impact: 'high',
          category: 'interactivity',
        });
        break;

      case 'CLS':
        results.push({
          diagnosis: 'Cumulative Layout Shift increased — visual instability',
          recommendation: 'Set explicit dimensions on images/ads, avoid injecting content above fold',
          impact: 'medium',
          category: 'visual-stability',
        });
        break;

      case 'FCP':
        results.push({
          diagnosis: 'First Contentful Paint degraded — initial render delay',
          recommendation: 'Reduce server response time, inline critical CSS, preload key resources',
          impact: 'high',
          category: 'loading',
        });
        break;

      case 'INP':
        results.push({
          diagnosis: 'Interaction to Next Paint degraded — input responsiveness',
          recommendation: 'Reduce event handler complexity, use passive listeners, debounce heavy callbacks',
          impact: 'high',
          category: 'interactivity',
        });
        break;

      case 'score':
        results.push({
          diagnosis: 'Overall Lighthouse score decreased',
          recommendation: 'Run full Lighthouse report and address top failing audits',
          impact: 'medium',
          category: 'overall',
        });
        break;
    }

    for (const r of results) {
      this.storage.storeDiagnosis({
        regressionId: regression.id,
        ...r,
      });
    }

    return results;
  }
}