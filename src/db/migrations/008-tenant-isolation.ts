import type { Database } from 'sql.js';

const TENANT_TABLES = [
  'checks',
  'check_results',
  'failure_events',
  'playbook_entries',
  'playbook_executions',
  'dependencies',
  'dependency_updates',
  'customers',
  'subscriptions',
  'remediation_log',
  'remediation_runs',
  'remediation_policies',
  'alert_channels',
  'alert_rules',
  'onboarding_sessions',
  'x_scheduled_posts',
  'usage_records',
  'webhook_events',
] as const;

function tableExists(db: Database, table: string): boolean {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
  return result.length > 0 && result[0].values.length > 0;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

function rebuildRemediationPolicies(db: Database): void {
  if (!tableExists(db, 'remediation_policies')) return;

  db.run('DROP TABLE IF EXISTS remediation_policies_tenant');
  db.run(`
    CREATE TABLE remediation_policies_tenant (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      failure_type TEXT NOT NULL,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      require_dry_run INTEGER NOT NULL DEFAULT 1,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
      UNIQUE(team_id, failure_type)
    )
  `);

  const teamId = hasColumn(db, 'remediation_policies', 'team_id') ? 'team_id' : 'NULL AS team_id';
  db.run(`
    INSERT INTO remediation_policies_tenant (id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes)
    SELECT id, ${teamId}, failure_type, auto_approve, require_dry_run, cooldown_minutes
    FROM remediation_policies
  `);

  db.run('DROP TABLE remediation_policies');
  db.run('ALTER TABLE remediation_policies_tenant RENAME TO remediation_policies');
}

export function up(db: Database): void {
  for (const table of TENANT_TABLES) {
    if (tableExists(db, table) && !hasColumn(db, table, 'team_id')) {
      db.run(`ALTER TABLE ${table} ADD COLUMN team_id TEXT`);
    }
  }

  rebuildRemediationPolicies(db);

  for (const table of TENANT_TABLES) {
    if (tableExists(db, table) && hasColumn(db, table, 'team_id')) {
      db.run(`CREATE INDEX IF NOT EXISTS idx_${table}_team ON ${table}(team_id)`);
    }
  }
}

function dropColumnWithFK(db: Database, table: string, column: string): void {
  if (!tableExists(db, table) || !hasColumn(db, table, column)) return;
  
  const colsResult = db.exec(`PRAGMA table_info(${table})`);
  if (!colsResult.length) return;
  const columns = colsResult[0].values.map((row: any) => row[1] as string).filter(c => c !== column);
  const colsDef = columns.map(c => `${c} ${getColumnType(db, table, c)}`).join(', ');
  
  db.run(`CREATE TABLE ${table}_no_${column} (${colsDef})`);
  const colList = columns.join(', ');
  db.run(`INSERT INTO ${table}_no_${column} (${colList}) SELECT ${colList} FROM ${table}`);
  db.run(`DROP TABLE ${table}`);
  db.run(`ALTER TABLE ${table}_no_${column} RENAME TO ${table}`);
}

function getColumnType(db: Database, table: string, column: string): string {
  const result = db.exec(`PRAGMA table_info(${table})`);
  if (!result.length) return 'TEXT';
  const row = result[0].values.find((r: any) => r[1] === column);
  return row ? `${row[2]}${row[3] ? ' NOT NULL' : ''}${row[4] !== null && row[4] !== undefined ? ' DEFAULT ' + row[4] : ''}` : 'TEXT';
}

export function down(db: Database): void {
  const indexes = [
    'idx_checks_team',
    'idx_check_results_team',
    'idx_failure_events_team',
    'idx_playbook_entries_team',
    'idx_dependencies_team',
    'idx_dependency_updates_team',
    'idx_customers_team',
    'idx_subscriptions_team',
    'idx_remediation_log_team',
    'idx_remediation_runs_team',
    'idx_remediation_policies_team',
    'idx_alert_channels_team',
    'idx_alert_rules_team',
    'idx_onboarding_sessions_team',
    'idx_x_scheduled_posts_team',
    'idx_usage_records_team',
    'idx_webhook_events_team',
  ];

  for (const index of indexes) {
    db.run(`DROP INDEX IF EXISTS ${index}`);
  }

  for (const table of TENANT_TABLES) {
    if (table === 'remediation_policies') continue;
    if (tableExists(db, table) && hasColumn(db, table, 'team_id')) {
      if (table === 'alert_channels') {
        dropColumnWithFK(db, table, 'team_id');
      } else {
        db.run(`ALTER TABLE ${table} DROP COLUMN team_id`);
      }
    }
  }

  if (tableExists(db, 'remediation_policies')) {
    db.run('DROP TABLE IF EXISTS remediation_policies_legacy');
    db.run(`
      CREATE TABLE remediation_policies_legacy (
        id TEXT PRIMARY KEY,
        team_id TEXT,
        failure_type TEXT NOT NULL,
        auto_approve INTEGER NOT NULL DEFAULT 0,
        require_dry_run INTEGER NOT NULL DEFAULT 1,
        cooldown_minutes INTEGER NOT NULL DEFAULT 60,
        UNIQUE(team_id, failure_type)
      )
    `);
    const teamId = hasColumn(db, 'remediation_policies', 'team_id') ? 'team_id' : 'NULL AS team_id';
    db.run(`
      INSERT INTO remediation_policies_legacy (id, team_id, failure_type, auto_approve, require_dry_run, cooldown_minutes)
      SELECT id, ${teamId}, failure_type, auto_approve, require_dry_run, cooldown_minutes
      FROM remediation_policies
    `);
    db.run('DROP TABLE remediation_policies');
    db.run('ALTER TABLE remediation_policies_legacy RENAME TO remediation_policies');
  }
}
