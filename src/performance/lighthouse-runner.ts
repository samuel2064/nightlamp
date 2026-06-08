import { execSync } from 'child_process';

export interface LighthouseConfig {
  chromeFlags?: string;
  throttling?: boolean;
  preset?: 'desktop' | 'mobile';
}

export interface LighthouseResult {
  url: string;
  lcp: number;
  tbt: number;
  cls: number;
  fcp: number;
  score: number;
  inp: number;
  rawJson: string;
  successful: boolean;
  error?: string;
}

export class LighthouseRunner {
  constructor(private config: LighthouseConfig = {}) {}

  async runAudit(url: string): Promise<LighthouseResult> {
    try {
      const preset = this.config.preset || 'mobile';
      const chromeFlags = this.config.chromeFlags || '--headless --no-sandbox';

      const cmd = `npx lighthouse "${url}" --output=json --${preset} --chrome-flags="${chromeFlags}" --quiet`;

      const stdout = execSync(cmd, { timeout: 120000, encoding: 'utf-8' });

      const raw = JSON.parse(stdout);

      const lcp = this.extractMetric(raw, 'largest-contentful-paint');
      const tbt = this.extractMetric(raw, 'total-blocking-time');
      const cls = this.extractMetric(raw, 'cumulative-layout-shift');
      const fcp = this.extractMetric(raw, 'first-contentful-paint');
      const inp = this.extractMetric(raw, 'interaction-to-next-paint');

      const score = raw.categories?.performance?.score || 0;

      return {
        url,
        lcp,
        tbt,
        cls,
        fcp,
        inp,
        score: score * 100,
        rawJson: stdout,
        successful: true,
      };
    } catch (err: any) {
      return {
        url,
        lcp: 0,
        tbt: 0,
        cls: 0,
        fcp: 0,
        inp: 0,
        score: 0,
        rawJson: '',
        successful: false,
        error: err.message,
      };
    }
  }

  private extractMetric(raw: any, id: string): number {
    const audit = raw.audits?.[id];
    if (!audit) return 0;

    if (audit.numericValue !== undefined) return audit.numericValue;

    return 0;
  }
}