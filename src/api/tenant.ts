export interface TenantFilter {
  clause: string;
  params: any[];
}

export type TenantTable =
  | 'checks'
  | 'check_results'
  | 'failure_events'
  | 'playbook_entries'
  | 'dependencies'
  | 'dependency_updates'
  | 'customers'
  | 'subscriptions'
  | 'remediation_log'
  | 'remediation_runs'
  | 'remediation_policies'
  | 'alert_channels'
  | 'alert_rules'
  | 'onboarding_sessions'
  | 'x_scheduled_posts'
  | 'usage_records'
  | 'webhook_events'
  | 'monitored_apps'
  | 'health_snapshots'
  | 'analytics_events'
  | 'feedback_responses';

export type OwnedTenantTable = 'alert_channels' | 'monitored_apps';

export function tenantFilter(column: string, teamId: string | null): TenantFilter {
  if (teamId === null) {
    return { clause: `${column} IS NULL`, params: [] };
  }
  return { clause: `${column} = ?`, params: [teamId] };
}

export function scopedTenantFilter(
  table: OwnedTenantTable,
  teamId: string | null,
  userId: string,
  includeLegacy = true,
  qualifyColumn = true,
): TenantFilter {
  const teamColumn = qualifyColumn ? `${table}.team_id` : 'team_id';
  const ownerColumn = qualifyColumn ? `${table}.owner_id` : 'owner_id';
  if (teamId !== null) {
    return tenantFilter(teamColumn, teamId);
  }
  const legacyClause = includeLegacy ? ` OR ${ownerColumn} IS NULL` : '';
  return {
    clause: `${teamColumn} IS NULL AND (${ownerColumn} = ?${legacyClause})`,
    params: [userId],
  };
}

export function rowBelongsToScope(
  db: { exec(sql: string, params?: any[]): any[] },
  table: OwnedTenantTable,
  id: string,
  teamId: string | null,
  userId: string,
  includeLegacy = true,
): boolean {
  const filter = scopedTenantFilter(table, teamId, userId, includeLegacy);
  const result = db.exec(
    `SELECT id FROM ${table} WHERE id = ? AND ${filter.clause}`,
    [id, ...filter.params],
  );
  return result.length > 0 && result[0].values.length > 0;
}

/**
 * Scope for rows that always belong to a tenant.
 *
 * The monitoring tables (failure_events, check_results, checks, remediation_runs,
 * dependencies) have no owner column, so the unscoped bucket (`team_id IS NULL`)
 * is shared by every personal identity. A caller without a team membership has
 * no rows of its own there, so the filter matches nothing and the routes that
 * use it answer 403 through `requireTenantScope` (NOC-319).
 */
export function tenantOwnedFilter(column: string, teamId: string | null): TenantFilter {
  if (teamId === null) {
    return { clause: '1 = 0', params: [] };
  }
  return { clause: `${column} = ?`, params: [teamId] };
}

export function tenantFilterForTables(
  table: TenantTable,
  teamId: string | null,
): TenantFilter {
  return tenantFilter(`${table}.team_id`, teamId);
}

export function rowBelongsToTenant(
  db: { exec(sql: string, params?: any[]): any[] },
  table: TenantTable,
  id: string,
  teamId: string | null,
): boolean {
  const filter = tenantFilterForTables(table, teamId);
  const result = db.exec(`SELECT id FROM ${table} WHERE id = ? AND ${filter.clause}`, [id, ...filter.params]);
  return result.length > 0 && result[0].values.length > 0;
}