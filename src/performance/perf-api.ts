import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { PerfOrchestrator } from './perf-orchestrator';
import { RegressionDetector } from './regression-detector';
import { PerfDiagnosis } from './perf-diagnosis';
import { PerfStorage } from './perf-storage';

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

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/performance/run' && req.method === 'POST') {
      this.handleRun(req, res);
      return true;
    }

    if (path === '/api/performance/history' && req.method === 'GET') {
      this.handleHistory(req, res);
      return true;
    }

    if (path === '/api/performance/regressions' && req.method === 'GET') {
      this.handleRegressions(req, res);
      return true;
    }

    if (path === '/api/performance/diagnosis' && req.method === 'GET') {
      this.handleDiagnosis(req, res);
      return true;
    }

    return false;
  }

  private handleRun(req: IncomingMessage, res: ServerResponse): void {
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

        const result = await this.orchestrator.runAudit(url);

        if (result.successful) {
          const runs = this.storage.getRecentRuns(url, 1);
          if (runs.length > 0) {
            const detection = this.detector.analyzeRuns(url, runs[0]);
            for (const reg of detection.regressions) {
              this.diagnosis.diagnose(url, reg);
            }
            res.end(JSON.stringify({ result, regressions: detection }));
            return;
          }
        }

        res.end(JSON.stringify({ result, regressions: { detected: false, regressions: [] } }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleHistory(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const url = parsedUrl.searchParams.get('url') || '';
    const metric = parsedUrl.searchParams.get('metric') || 'LCP';
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '24', 10);

    if (!url) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'url is required' }));
      return;
    }

    const history = this.storage.getMetricHistory(url, metric, limit);
    const baseline = this.storage.getBaseline(url, metric);
    res.end(JSON.stringify({ url, metric, history, baseline }));
  }

  private handleRegressions(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const url = parsedUrl.searchParams.get('url') || undefined;
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '20', 10);

    const regressions = this.storage.getRegressions(url, limit);
    res.end(JSON.stringify({ regressions, count: regressions.length }));
  }

  private handleDiagnosis(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const regressionId = parsedUrl.searchParams.get('regressionId') || '';

    if (!regressionId) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'regressionId is required' }));
      return;
    }

    const diagnoses = this.storage.getDiagnoses(regressionId);
    res.end(JSON.stringify({ diagnoses, count: diagnoses.length }));
  }
}