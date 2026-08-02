import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { PerfStorage } from './perf-storage';
import { RegressionDetector } from './regression-detector';

export interface SloDefinition {
  metric: string;
  target: number;
  unit: string;
  comparison: 'lt' | 'gt';
  description: string;
  errorBudgetMinutes: number;
}

export interface SloBreach {
  id: string;
  metric: string;
  currentValue: number;
  target: number;
  url: string;
  breachedAt: string;
  acknowledged: boolean;
  errorBudgetRemaining: number;
}

export const DEFAULT_SLOS: SloDefinition[] = [
  {
    metric: 'LCP',
    target: 2500,
    unit: 'ms',
    comparison: 'lt',
    description: 'Largest Contentful Paint should be under 2500ms',
    errorBudgetMinutes: 43200,
  },
  {
    metric: 'TBT',
    target: 200,
    unit: 'ms',
    comparison: 'lt',
    description: 'Total Blocking Time should be under 200ms',
    errorBudgetMinutes: 43200,
  },
  {
    metric: 'CLS',
    target: 0.1,
    unit: '',
    comparison: 'lt',
    description: 'Cumulative Layout Shift should be under 0.1',
    errorBudgetMinutes: 43200,
  },
  {
    metric: 'FCP',
    target: 1800,
    unit: 'ms',
    comparison: 'lt',
    description: 'First Contentful Paint should be under 1800ms',
    errorBudgetMinutes: 43200,
  },
  {
    metric: 'INP',
    target: 200,
    unit: 'ms',
    comparison: 'lt',
    description: 'Interaction to Next Paint should be under 200ms',
    errorBudgetMinutes: 43200,
  },
  {
    metric: 'score',
    target: 0.85,
    unit: '',
    comparison: 'gt',
    description: 'Performance score should be at least 0.85',
    errorBudgetMinutes: 43200,
  },
];

const PHASE_3_SLOS: SloDefinition[] = [
  {
    metric: 'onboarding_completion',
    target: 300,
    unit: 's',
    comparison: 'lt',
    description: 'Onboarding completion should be under 5 minutes (300s)',
    errorBudgetMinutes: 10080,
  },
  {
    metric: 'playbook_save',
    target: 200,
    unit: 'ms',
    comparison: 'lt',
    description: 'Playbook save should be under 200ms',
    errorBudgetMinutes: 10080,
  },
  {
    metric: 'notification_delivery',
    target: 2000,
    unit: 'ms',
    comparison: 'lt',
    description: 'Notification delivery should be under 2 seconds (2000ms)',
    errorBudgetMinutes: 10080,
  },
  {
    metric: 'report_generation',
    target: 5000,
    unit: 'ms',
    comparison: 'lt',
    description: 'Report generation should be under 5 seconds (5000ms)',
    errorBudgetMinutes: 10080,
  },
  {
    metric: 'api_p99',
    target: 500,
    unit: 'ms',
    comparison: 'lt',
    description: 'API p99 latency should be under 500ms',
    errorBudgetMinutes: 10080,
  },
];

export class SloMonitor {
  private slos: SloDefinition[];
  private breachLog: Map<string, SloBreach[]> = new Map();

  constructor(
    private storage: PerfStorage,
    private detector: RegressionDetector,
    slos?: SloDefinition[]
  ) {
    this.slos = slos || [...DEFAULT_SLOS, ...PHASE_3_SLOS];
  }

  getDefinitions(): SloDefinition[] {
    return this.slos;
  }

  checkSlo(url: string, metricName: string, currentValue: number): SloBreach | null {
    const slo = this.slos.find(s => s.metric === metricName);
    if (!slo) return null;

    const breached = slo.comparison === 'lt'
      ? currentValue > slo.target
      : currentValue < slo.target;

    if (!breached) return null;

    const baseline = this.storage.getBaseline(url, metricName);
    const totalMinutes = slo.errorBudgetMinutes;
    const breachedMinutes = baseline.count > 0 ? Math.ceil(Math.abs(currentValue - slo.target) / slo.target * totalMinutes) : 0;
    const remaining = Math.max(0, totalMinutes - breachedMinutes);

    const breach: SloBreach = {
      id: uuidv4(),
      metric: metricName,
      currentValue,
      target: slo.target,
      url,
      breachedAt: new Date().toISOString(),
      acknowledged: false,
      errorBudgetRemaining: remaining,
    };

    const existingBreaches = this.breachLog.get(url) || [];
    existingBreaches.push(breach);
    this.breachLog.set(url, existingBreaches);

    return breach;
  }

  checkLighthouseRun(url: string, run: { lcp: number; tbt: number; cls: number; fcp: number; inp: number; score: number }): SloBreach[] {
    const breaches: SloBreach[] = [];
    const metrics: { name: string; value: number }[] = [
      { name: 'LCP', value: run.lcp },
      { name: 'TBT', value: run.tbt },
      { name: 'CLS', value: run.cls },
      { name: 'FCP', value: run.fcp },
      { name: 'INP', value: run.inp },
      { name: 'score', value: run.score },
    ];

    for (const m of metrics) {
      const breach = this.checkSlo(url, m.name, m.value);
      if (breach) breaches.push(breach);
    }

    return breaches;
  }

  acknowledgeBreach(breachId: string): boolean {
    for (const [, breaches] of this.breachLog) {
      const found = breaches.find(b => b.id === breachId);
      if (found) {
        found.acknowledged = true;
        return true;
      }
    }
    return false;
  }

  getBreaches(url?: string): SloBreach[] {
    if (url) return this.breachLog.get(url) || [];
    const all: SloBreach[] = [];
    for (const breaches of this.breachLog.values()) {
      all.push(...breaches);
    }
    return all;
  }

  summarize(url: string): { sloPass: boolean; breaches: SloBreach[]; totalSlos: number } {
    const breaches = this.getBreaches(url);
    return {
      sloPass: breaches.length === 0,
      breaches,
      totalSlos: this.slos.length,
    };
  }
}

export { PHASE_3_SLOS };
