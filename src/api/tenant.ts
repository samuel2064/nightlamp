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

export function tenantFilter(column: string, teamId: string | null): TenantFilter {
  if (teamId === null) {
    return { clause: `${column} IS NULL`, params: [] };
  }
  return { clause: `${column} = ?`, params: [teamId] };
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

/**
 * Tables that carry both a team scope and a personal ownership column.
 *
 * A monitored application and an alert channel can belong to a team, or to the
 * individual who created it before that individual joined a team.
 */
export type OwnedTenantTable = 'alert_channels' | 'monitored_apps';

/**
 * Scope for rows owned by a team or by an individual.
 *
 * The scope fails closed. A caller with a team membership sees exactly that
 * team's rows. A caller without one sees only the rows it personally owns, and
 * an empty owner never matches, because a signed-in user with no ownership is
 * refused rather than shown a shared bucket. Rows with no owner at all are
 * never readable by an arbitrary signed-in user and never become bindable to
 * one (NOC-303 blocker 3).
 */
export function scopedTenantFilter(
  table: OwnedTenantTable,
  teamId: string | null,
  userId: string,
  qualifyColumn = true,
): TenantFilter {
  const teamColumn = qualifyColumn ? `${table}.team_id` : 'team_id';
  const ownerColumn = qualifyColumn ? `${table}.owner_id` : 'owner_id';

  if (teamId !== null) {
    return tenantFilter(teamColumn, teamId);
  }

  // Personal scope requires a real ownership predicate. A missing caller
  // identity matches nothing, and an owner-less legacy row is not readable.
  if (!userId) {
    return { clause: '1 = 0', params: [] };
  }

  return {
    clause: `${teamColumn} IS NULL AND ${ownerColumn} = ?`,
    params: [userId],
  };
}

/**
 * Whether a single row is inside the caller's scope.
 *
 * The same fail-closed rule as `scopedTenantFilter`: a teamless caller must own
 * the row, and an owner-less row belongs to nobody.
 */
export function rowBelongsToScope(
  db: { exec(sql: string, params?: any[]): any[] },
  table: OwnedTenantTable,
  id: string,
  teamId: string | null,
  userId: string,
  qualifyColumn = true,
): boolean {
  const filter = scopedTenantFilter(table, teamId, userId, qualifyColumn);
  const result = db.exec(
    `SELECT id FROM ${table} WHERE id = ? AND ${filter.clause}`,
    [id, ...filter.params],
  );
  return result.length > 0 && result[0].values.length > 0;
}

/**
 * Shared referenced-channel delete guard.
 *
 * Refuses to delete an alert channel if any monitored application references it.
 * Used by both the notifications API and the alerting API channel delete routes.
 *
 * Returns an error response object if the channel cannot be deleted, or null if
 * the deletion can proceed. The caller is responsible for sending the response.
 */
export interface ChannelDeleteGuardResult {
  error: string;
  code: string;
  status: number;
}

export function requireChannelOwnership(
  db: { exec(sql: string, params?: any[]): any[] },
  channelId: string,
  teamId: string | null,
  userId: string,
): ChannelDeleteGuardResult | null {
  // First: verify the caller is in scope (team scope or personal ownership)
  if (!rowBelongsToScope(db, 'alert_channels', channelId, teamId, userId)) {
    // Fail closed: return 404 for any unauthorized access (teamless or wrong owner)
    return { error: 'Channel not found', code: 'NOT_FOUND', status: 404 };
  }

  // Second: for team channels, verify the caller is the channel owner
  // (personal channels already enforce ownership via rowBelongsToScope)
  if (teamId !== null) {
    const channel = db.exec('SELECT owner_id FROM alert_channels WHERE id = ?', [channelId]);
    if (channel.length === 0 || channel[0].values.length === 0 || channel[0].values[0][0] !== userId) {
      return { error: 'Only the channel owner can delete this channel', code: 'FORBIDDEN', status: 403 };
    }
  }

  // Third: shared referenced-channel delete guard - refuse if a monitored app references this channel
  const attached = db.exec('SELECT id FROM monitored_apps WHERE alert_channel_id = ? LIMIT 1', [channelId]);
  if (attached.length > 0 && attached[0].values.length > 0) {
    return { error: 'Channel is referenced by a monitored application', code: 'CHANNEL_IN_USE', status: 409 };
  }

  return null;
}
