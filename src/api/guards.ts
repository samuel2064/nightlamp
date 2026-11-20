import { ServerResponse } from 'http';

/**
 * Guard for resources that are always owned by a tenant.
 *
 * The monitoring tables have no owner column, so a signed-in user without a
 * team membership has no rows of its own. Those routes fail closed with 403
 * instead of answering with the unscoped bucket that every personal identity
 * shares (NOC-319).
 */
export function requireTenantScope(res: ServerResponse, teamId: string | null): boolean {
  if (teamId !== null) return true;
  res.writeHead(403);
  res.end(JSON.stringify({
    error: 'A team membership is required to access this resource',
    code: 'FORBIDDEN',
  }));
  return false;
}