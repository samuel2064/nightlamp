import * as cron from 'node-cron';
import { Database } from 'sql.js';
import { LighthouseRunner, LighthouseResult, LighthouseConfig } from './lighthouse-runner';
import { PerfStorage } from './perf-storage';

export class PerfOrchestrator {
  private runner: LighthouseRunner;
  public storage: PerfStorage;

  constructor(
    private db: Database,
    config?: LighthouseConfig,
  ) {
    this.runner = new LighthouseRunner(config);
    this.storage = new PerfStorage(db);
  }

  async runAudit(url: string, teamId: string): Promise<LighthouseResult> {
    const runId = this.storage.createRun(url, teamId);
    const result = await this.runner.runAudit(url);
    this.storage.completeRun(runId, result, teamId);
    return result;
  }

  schedule(url: string, cronExpr: string, teamId: string): void {
    cron.schedule(cronExpr, async () => {
      console.log(`[PerfOrchestrator] Running scheduled audit for ${url}`);
      try {
        const result = await this.runAudit(url, teamId);
        if (result.successful) {
          console.log(`[PerfOrchestrator] ${url} - LCP: ${result.lcp}ms, Score: ${result.score}`);
        } else {
          console.error(`[PerfOrchestrator] ${url} audit failed: ${result.error}`);
        }
      } catch (err: any) {
        console.error(`[PerfOrchestrator] ${url} error:`, err.message);
      }
    });

    console.log(`[PerfOrchestrator] Scheduled ${url} with "${cronExpr}" for team ${teamId}`);
  }
}