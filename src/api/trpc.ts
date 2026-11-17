import { initTRPC, TRPCError } from '@trpc/server';
import { z } from 'zod';
import superjson from 'superjson';
import { Database } from 'sql.js';
import { PlaybookEngine, createPlaybookEngine, PlaybookExecution, PlaybookDefinition, PlaybookStep } from '../playbook/engine';
import { ApiAuthError, TeamRole, VerifiedTokenClaims, upsertUser, verifyAccessToken, verifyAccessTokenAsync, extractBearerToken } from './auth';
import { IncomingMessage } from 'http';
import * as crypto from 'crypto';

export interface UserInfo {
  id: string;
  email: string;
  teamIds: string[];
  roles?: Record<string, TeamRole>;
}

export interface TRPCContext {
  db: Database;
  playbookEngine: PlaybookEngine;
  user: UserInfo | null;
}

const t = initTRPC.context<TRPCContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const protectedProcedure = publicProcedure.use(async ({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

function getUserFromToken(token: string | undefined, db: Database): UserInfo | null {
  if (!token) return null;

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err: any) {
    if (err instanceof ApiAuthError && err.code === 'AUTH_NOT_CONFIGURED') {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication is not configured' });
    }
    return null;
  }

  return buildUserInfo(db, claims);
}

async function getUserFromTokenAsync(token: string | undefined, db: Database): Promise<UserInfo | null> {
  if (!token) return null;

  let claims;
  try {
    claims = await verifyAccessTokenAsync(token);
  } catch (err: any) {
    if (err instanceof ApiAuthError && err.code === 'AUTH_NOT_CONFIGURED') {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication is not configured' });
    }
    return null;
  }

  return buildUserInfo(db, claims);
}

function buildUserInfo(db: Database, claims: VerifiedTokenClaims): UserInfo {
  const user = upsertUser(db, claims);
  const result = db.exec(
    `SELECT m.team_id, m.role FROM memberships m
     JOIN users u ON u.id = m.user_id
     WHERE u.clerk_user_id = ? AND m.team_id IS NOT NULL`,
    [claims.sub]
  );

  const teamIds: string[] = [];
  const roles: Record<string, TeamRole> = {};
  if (result.length > 0) {
    for (const row of result[0].values as any[]) {
      const teamId = row[0] as string;
      teamIds.push(teamId);
      roles[teamId] = row[1] as TeamRole;
    }
  }

  return {
    id: user.id,
    email: user.email,
    teamIds,
    roles,
  };
}

export function extractAuthFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return undefined;
}

export async function createTRPCContextFromRequest(
  db: Database, 
  playbookEngine: PlaybookEngine, 
  req: Request
): Promise<TRPCContext> {
  const token = extractAuthFromRequest(req);
  const user = await getUserFromTokenAsync(token, db);
  return { db, playbookEngine, user };
}

export async function createTRPCContextFromNodeRequest(
  db: Database,
  playbookEngine: PlaybookEngine,
  req: IncomingMessage
): Promise<TRPCContext> {
  const token = extractBearerToken(req.headers) || undefined;
  const user = await getUserFromTokenAsync(token, db);
  return { db, playbookEngine, user };
}

export function createTRPCContext(db: Database, playbookEngine: PlaybookEngine): TRPCContext {
  return { db, playbookEngine, user: null };
}

function assertTeamAccess(ctx: TRPCContext, teamId: string): void {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  if (!ctx.user.teamIds.includes(teamId)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this team' });
  }
}

function assertTeamRole(ctx: TRPCContext, teamId: string, allowedRoles: TeamRole[]): void {
  assertTeamAccess(ctx, teamId);
  const role = ctx.user?.roles?.[teamId];
  if (!role || !allowedRoles.includes(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient permissions for this team' });
  }
}

function listAccessiblePlaybookIds(ctx: TRPCContext): Set<string> {
  const ids = new Set<string>();
  if (!ctx.user || ctx.user.teamIds.length === 0) return ids;
  const placeholders = ctx.user.teamIds.map(() => '?').join(', ');
  const result = ctx.db.exec(
    `SELECT id FROM custom_playbooks WHERE team_id IN (${placeholders})`,
    ctx.user.teamIds
  );
  if (result.length > 0) {
    for (const row of result[0].values as any[]) {
      ids.add(row[0] as string);
    }
  }
  return ids;
}

export const playbookRouter = router({
  listExecutions: protectedProcedure
    .input(z.object({ playbookId: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      const accessible = listAccessiblePlaybookIds(ctx);
      const executions = ctx.playbookEngine
        .listExecutions(input?.playbookId)
        .filter((execution) => accessible.has(execution.playbookId));
      return { executions, count: executions.length };
    }),

  getExecution: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      const execution = ctx.playbookEngine.getExecution(input.id);
      if (!execution) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Execution not found' });
      }
      if (!listAccessiblePlaybookIds(ctx).has(execution.playbookId)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this team' });
      }
      return { execution };
    }),

  createExecution: protectedProcedure
    .input(z.object({
      playbookId: z.string(),
      context: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const playbook = ctx.playbookEngine.getPlaybookDefinition(input.playbookId);
      if (!playbook) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const playbookResult = ctx.db.exec('SELECT team_id FROM custom_playbooks WHERE id = ?', [input.playbookId]);
      if (playbookResult.length === 0 || playbookResult[0].values.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const teamId = playbookResult[0].values[0][0] as string;
      assertTeamAccess(ctx, teamId);
      
      const execution = await ctx.playbookEngine.createExecution(playbook, input.context || {});
      await ctx.playbookEngine.startExecution(execution.id);
      return { execution: ctx.playbookEngine.getExecution(execution.id) };
    }),

  provideDecision: protectedProcedure
    .input(z.object({
      executionId: z.string(),
      decision: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      const execution = ctx.playbookEngine.getExecution(input.executionId);
      if (!execution) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Execution not found' });
      }
      const playbook = ctx.playbookEngine.getPlaybookDefinition(execution.playbookId);
      if (!playbook) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const playbookResult = ctx.db.exec('SELECT team_id FROM custom_playbooks WHERE id = ?', [execution.playbookId]);
      if (playbookResult.length === 0 || playbookResult[0].values.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const teamId = playbookResult[0].values[0][0] as string;
      assertTeamAccess(ctx, teamId);
      
      try {
        const updatedExecution = await ctx.playbookEngine.provideDecision(input.executionId, input.decision);
        return { execution: updatedExecution };
      } catch (err: any) {
        if (err.message.includes('not found')) {
          throw new TRPCError({ code: 'NOT_FOUND', message: err.message });
        }
        throw err;
      }
    }),

  cancelExecution: protectedProcedure
    .input(z.object({ executionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const execution = ctx.playbookEngine.getExecution(input.executionId);
      if (!execution) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Execution not found' });
      }
      const playbook = ctx.playbookEngine.getPlaybookDefinition(execution.playbookId);
      if (!playbook) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const playbookResult = ctx.db.exec('SELECT team_id FROM custom_playbooks WHERE id = ?', [execution.playbookId]);
      if (playbookResult.length === 0 || playbookResult[0].values.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const teamId = playbookResult[0].values[0][0] as string;
      assertTeamAccess(ctx, teamId);
      
      const updatedExecution = await ctx.playbookEngine.cancelExecution(input.executionId);
      return { execution: updatedExecution };
    }),

  listPlaybooks: protectedProcedure
    .input(z.object({ teamId: z.string() }))
    .query(({ ctx, input }) => {
      assertTeamAccess(ctx, input.teamId);
      const result = ctx.db.exec(
        'SELECT id, team_id, name, description, status, version, created_at, updated_at FROM custom_playbooks WHERE team_id = ? ORDER BY updated_at DESC',
        [input.teamId]
      );
      const playbooks = result.length > 0 ? result[0].values.map((row: any) => ({
        id: row[0],
        teamId: row[1],
        name: row[2],
        description: row[3],
        status: row[4],
        version: row[5],
        createdAt: row[6],
        updatedAt: row[7],
      })) : [];
      return { playbooks, count: playbooks.length };
    }),

  getPlaybook: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => {
      const result = ctx.db.exec(
        'SELECT id, team_id, name, description, status, version, created_at, updated_at FROM custom_playbooks WHERE id = ?',
        [input.id]
      );
      if (result.length === 0 || result[0].values.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const row = result[0].values[0];
      const teamId = row[1] as string;
      assertTeamAccess(ctx, teamId);
      
      return {
        playbook: {
          id: row[0],
          teamId: row[1],
          name: row[2],
          description: row[3],
          status: row[4],
          version: row[5],
          createdAt: row[6],
          updatedAt: row[7],
        },
      };
    }),

  createPlaybook: protectedProcedure
    .input(z.object({
      teamId: z.string(),
      name: z.string(),
      description: z.string().optional(),
    }))
    .mutation(({ ctx, input }) => {
      assertTeamAccess(ctx, input.teamId);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      ctx.db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', 1, ?, ?)`,
        [id, input.teamId, input.name, input.description || '', now, now]
      );
      return { playbook: { id, teamId: input.teamId, name: input.name, description: input.description || '', status: 'draft', version: 1, createdAt: now, updatedAt: now } };
    }),

  updatePlaybook: protectedProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      status: z.enum(['draft', 'published']).optional(),
    }))
    .mutation(({ ctx, input }) => {
      const result = ctx.db.exec('SELECT team_id FROM custom_playbooks WHERE id = ?', [input.id]);
      if (result.length === 0 || result[0].values.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const teamId = result[0].values[0][0] as string;
      assertTeamRole(ctx, teamId, ['owner', 'admin']);
      
      const updates: string[] = [];
      const params: any[] = [];
      if (input.name !== undefined) { updates.push('name = ?'); params.push(input.name); }
      if (input.description !== undefined) { updates.push('description = ?'); params.push(input.description); }
      if (input.status !== undefined) { updates.push('status = ?'); params.push(input.status); }
      if (updates.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No fields provided to update' });
      }
      updates.push("updated_at = datetime('now')");
      updates.push("version = version + 1");
      ctx.db.run(`UPDATE custom_playbooks SET ${updates.join(', ')} WHERE id = ?`, [...params, input.id]);
      const updatedResult = ctx.db.exec('SELECT id, team_id, name, description, status, version, created_at, updated_at FROM custom_playbooks WHERE id = ?', [input.id]);
      const row = updatedResult[0].values[0];
      return {
        playbook: {
          id: row[0],
          teamId: row[1],
          name: row[2],
          description: row[3],
          status: row[4],
          version: row[5],
          createdAt: row[6],
          updatedAt: row[7],
        },
      };
    }),

  deletePlaybook: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      const result = ctx.db.exec('SELECT team_id FROM custom_playbooks WHERE id = ?', [input.id]);
      if (result.length === 0 || result[0].values.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Playbook not found' });
      }
      const teamId = result[0].values[0][0] as string;
      assertTeamRole(ctx, teamId, ['owner', 'admin']);
      
      ctx.db.run('DELETE FROM custom_playbooks WHERE id = ?', [input.id]);
      return { success: true };
    }),
});

export type PlaybookRouter = typeof playbookRouter;

export const healthRouter = router({
  status: publicProcedure.query(() => ({
    ok: true,
    service: 'nightlamp-api',
    transport: 'trpc',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  })),
});

export type HealthRouter = typeof healthRouter;

export const appRouter = router({
  health: healthRouter,
  playbook: playbookRouter,
});

export type AppRouter = typeof appRouter;