import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { PerfOrchestrator } from './perf-orchestrator';
import { RegressionDetector } from './regression-detector';
import { PerfDiagnosis } from './perf-diagnosis';
import { PerfStorage } from './perf-storage';
import { requireTenantScope } from '../api/guards';

export interface PerfApiAuthContext {
  teamId: string | null;
}

export class PerfApi {
  private orchestrator: PerfOrchestrator;
  private detector: RegressionDetector;
  private diagnosis: PerfDiagnosis;
  private storage: PerfStorage;

  constructor(private db: Database) {
    this.orchestrator = new PerfOrchestrator(db);
    this.storage = this.orchestrator.storage;
    this.detector = new RegressionDetector(this.storage);
    this.diagnosis = new PerfDiagnosis(this.storage);
  }

  handle(req: IncomingMessage, res: ServerResponse, auth: PerfApiAuthContext): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (!requireTenantScope(res, auth.teamId)) return true;

    if (path === '/api/performance/run' && req.method === 'POST') {
      this.handleRun(req, res, auth.teamId!);
      return true;
    }

    if (path === '/api/performance/history' && req.method === 'GET') {
      this.handleHistory(req, res, auth.teamId!);
      return true;
    }

    if (path === '/api/performance/regressions' && req.method === 'GET') {
      this.handleRegressions(req, res, auth.teamId!);
      return true;
    }

    if (path === '/api/performance/diagnosis' && req.method === 'GET') {
      this.handleDiagnosis(req, res, auth.teamId!);
      return true;
    }

    return false;
  }

  private handleRun(req: IncomingMessage, res: ServerResponse, teamId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'url is required' }));
          return;
        }

        const runId = this.storage.createRun(url, teamId);
        const result = await this.orchestrator.runAudit(url);

        if (result.successful) {
          const runs = this.storage.getRecentRuns(url, teamId, 1);
          if (runs.length > 0) {
            const detection = this.detector.analyzeRuns(url, runs[0]);
            for (const reg of detection.regressions) {
              this.diagnosis.diagnose(url, reg, teamId);
            }
            this.storage.completeRun(runId, result, teamId);
            res.end(JSON.stringify({ result, regressions: detection }));
            return;
          }
        }

        this.storage.completeRun(runId, result, teamId);
        res.end(JSON.stringify({ result, regressions: { detected: false, regressions: [] } }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleHistory(req: IncomingMessage, res: ServerResponse, teamId: string): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const url = parsedUrl.searchParams.get('url') || '';
    const metric = parsedUrl.searchParams.get('metric') || 'LCP';
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '24', 10);

    if (!url) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'url is required' }));
      return;
    }

    const history = this.storage.getMetricHistory(url, teamId, metric, limit);
    const baseline = this.storage.getBaseline(url, teamId, metric);
    res.end(JSON.stringify({ url, metric, history, baseline }));
  }

  private handleRegressions(req: IncomingMessage, res: ServerResponse, teamId: string): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const url = parsedUrl.searchParams.get('url') || undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '20', 10);

    const regressions = this.storage.getRegressions(teamId, url, limit);
    res.end(JSON.stringify({ regressions, count: regressions.length }));
  }

  private handleDiagnosis(req: IncomingMessage, res: ServerResponse, teamId: string): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const regressionId = parsedUrl.searchParams.get('regressionId') || '';

    if (!regressionId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'regressionId is required' }));
      return;
    }

    const diagnoses = this.storage.getDiagnoses(teamId, regressionId);
    res.end(JSON.stringify({ diagnoses, count: diagnoses.length }));
  }
}