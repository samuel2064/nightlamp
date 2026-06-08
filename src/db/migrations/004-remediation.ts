import type { Database } from 'sql.js'

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_actions (
      id TEXT PRIMARY KEY,
      failure_type TEXT NOT NULL,
      action_name TEXT NOT NULL,
      description TEXT,
      risk_level TEXT NOT NULL DEFAULT 'medium',
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_runs (
      id TEXT PRIMARY KEY,
      playbook_entry_id TEXT REFERENCES playbook_entries(id),
      action_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      initiated_by TEXT,
      approved_by TEXT,
      output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_policies (
      id TEXT PRIMARY KEY,
      failure_type TEXT NOT NULL,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      require_dry_run INTEGER NOT NULL DEFAULT 1,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
      UNIQUE(failure_type)
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_remediation_runs_status ON remediation_runs(status)')
  db.run('CREATE INDEX IF NOT EXISTS idx_remediation_runs_action ON remediation_runs(action_name)')
  db.run('CREATE INDEX IF NOT EXISTS idx_remediation_actions_failure ON remediation_actions(failure_type)')
}

export function down(db: Database): void {
  db.run('DROP TABLE IF EXISTS remediation_policies')
  db.run('DROP TABLE IF EXISTS remediation_runs')
  db.run('DROP TABLE IF EXISTS remediation_actions')
}
