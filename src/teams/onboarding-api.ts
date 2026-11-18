import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { AuthContext } from '../api/auth';
import { tenantFilter } from '../api/tenant';

type OnboardingStep = 'app-detection' | 'monitor-selection' | 'alert-config' | 'team-invite';

const STEP_ORDER: OnboardingStep[] = ['app-detection', 'monitor-selection', 'alert-config', 'team-invite'];

const VALID_STEPS = new Set<string>(STEP_ORDER);

export class OnboardingApi {
  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null = null): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;
    const teamId = auth ? auth.teamId : null;

    if (path === '/api/onboarding/start' || path === '/api/onboarding/start/') {
      if (req.method === 'POST') { this.handleStart(req, res, auth, teamId); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const sessionMatch = path.match(/^\/api\/onboarding\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (sessionMatch) {
      const sessionId = sessionMatch[1];
      const subPath = (sessionMatch[2] || '').replace(/\/+$/, '');

      if (!subPath) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not found' }));
        return true;
      }

      if (subPath === '/status') {
        if (req.method === 'GET') { this.handleStatus(sessionId, res, teamId, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/step') {
        if (req.method === 'POST') { this.handleStep(req, sessionId, res, teamId, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/complete') {
        if (req.method === 'POST') { this.handleComplete(sessionId, res, teamId, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }

    return false;
  }

  private handleStart(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null, teamId: string | null): void {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const userId = auth.userId;

        const scope = tenantFilter('team_id', teamId);
        const existing = this.db.exec(
          `SELECT id, current_step FROM onboarding_sessions WHERE user_id = ? AND ${scope.clause} AND completed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
          [userId, ...scope.params]
        );
        if (existing.length > 0 && existing[0].values.length > 0) {
          const row = existing[0].values[0];
          res.end(JSON.stringify({
            success: true,
            sessionId: row[0],
            currentStep: row[1],
            resumed: true,
          }));
          return;
        }

        const id = uuidv4();
        this.db.run(
          `INSERT INTO onboarding_sessions (id, user_id, current_step, step_data, team_id) VALUES (?, ?, 'app-detection', '{}', ?)`,
          [id, userId, teamId]
        );

        res.end(JSON.stringify({
          success: true,
          sessionId: id,
          userId,
          currentStep: 'app-detection',
          resumed: false,
        }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleStatus(sessionId: string, res: ServerResponse, teamId: string | null, auth: AuthContext | null): void {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    const scope = tenantFilter('team_id', teamId);
    const result = this.db.exec(
      `SELECT id, user_id, current_step, step_data, completed_at, created_team_id, created_at, updated_at FROM onboarding_sessions WHERE id = ? AND user_id = ? AND ${scope.clause}`,
      [sessionId, auth.userId, ...scope.params]
    );

    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const row = result[0].values[0];
    const completedAt = row[4] as string | null;

    res.end(JSON.stringify({
      session: {
        id: row[0],
        userId: row[1],
        currentStep: row[2],
        stepData: JSON.parse(row[3] as string),
        completed: completedAt !== null,
        completedAt: completedAt,
        createdTeamId: row[5],
        createdAt: row[6],
        updatedAt: row[7],
      },
    }));
  }

  private handleStep(req: IncomingMessage, sessionId: string, res: ServerResponse, teamId: string | null, auth: AuthContext | null): void {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const scope = tenantFilter('team_id', teamId);
        const sessionResult = this.db.exec(
          `SELECT id, current_step, completed_at FROM onboarding_sessions WHERE id = ? AND user_id = ? AND ${scope.clause}`,
          [sessionId, auth.userId, ...scope.params]
        );

        if (sessionResult.length === 0 || sessionResult[0].values.length === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        const row = sessionResult[0].values[0];
        const currentStep = row[1] as OnboardingStep;
        const completedAt = row[2] as string | null;

        if (completedAt !== null) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Session already completed' }));
          return;
        }

        const { step, data } = JSON.parse(body);
        if (!step) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'step is required' }));
          return;
        }

        if (!VALID_STEPS.has(step)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Invalid step. Must be one of: ${STEP_ORDER.join(', ')}` }));
          return;
        }

        const currentIndex = STEP_ORDER.indexOf(currentStep);
        const targetIndex = STEP_ORDER.indexOf(step);

        if (targetIndex !== currentIndex + 1) {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: `Step out of order. Current step is '${currentStep}', expected next step is '${STEP_ORDER[currentIndex + 1]}'`,
            currentStep,
            expectedNextStep: STEP_ORDER[currentIndex + 1],
          }));
          return;
        }

        const existingData = this.db.exec(
          `SELECT step_data FROM onboarding_sessions WHERE id = ? AND user_id = ? AND ${scope.clause}`,
          [sessionId, auth.userId, ...scope.params]
        );
        const currentData = existingData.length > 0 && existingData[0].values.length > 0
          ? JSON.parse(existingData[0].values[0][0] as string)
          : {};

        currentData[step] = data || {};

        this.db.run(
          `UPDATE onboarding_sessions SET current_step = ?, step_data = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND ${scope.clause}`,
          [step, JSON.stringify(currentData), sessionId, auth.userId, ...scope.params]
        );

        res.end(JSON.stringify({
          success: true,
          sessionId,
          previousStep: currentStep,
          currentStep: step,
          isLastStep: step === 'team-invite',
        }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleComplete(sessionId: string, res: ServerResponse, teamId: string | null, auth: AuthContext | null): void {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    try {
      const scope = tenantFilter('team_id', teamId);
      const sessionResult = this.db.exec(
        `SELECT id, current_step, completed_at FROM onboarding_sessions WHERE id = ? AND user_id = ? AND ${scope.clause}`,
        [sessionId, auth.userId, ...scope.params]
      );

      if (sessionResult.length === 0 || sessionResult[0].values.length === 0) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const row = sessionResult[0].values[0];
      const currentStep = row[1] as OnboardingStep;
      const completedAt = row[2] as string | null;

      if (completedAt !== null) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Session already completed' }));
        return;
      }

      if (currentStep !== 'team-invite') {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: `Cannot complete session at step '${currentStep}'. Must be at 'team-invite' step first.`,
          currentStep,
        }));
        return;
      }

      const newTeamId = uuidv4();
      const workspaceId = uuidv4();

      this.db.run(
        `INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, 'free')`,
        [newTeamId, `Team-${sessionId.slice(0, 8)}`, `team-${sessionId.slice(0, 8)}`, auth.userId]
      );

      this.db.run(
        'INSERT INTO team_workspaces (id, team_id) VALUES (?, ?)',
        [workspaceId, newTeamId]
      );

      this.db.run(
        'INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
        [uuidv4(), newTeamId, auth.userId, 'owner']
      );

      this.db.run(
        `UPDATE onboarding_sessions SET completed_at = datetime('now'), created_team_id = ?, team_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ? AND ${scope.clause}`,
        [newTeamId, newTeamId, sessionId, auth.userId, ...scope.params]
      );

      res.end(JSON.stringify({
        success: true,
        sessionId,
        teamId: newTeamId,
        workspaceId,
        completedAt: new Date().toISOString(),
      }));
    } catch (err: any) {
      if (err.message && err.message.includes('UNIQUE')) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Team slug conflict, please restart onboarding' }));
        return;
      }
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  }
}
