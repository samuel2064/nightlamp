import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';

export interface NightlampDb {
  db: SqlJsDatabase;
}

export async function createDatabase(dbPath?: string): Promise<SqlJsDatabase> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS check_results (
      id TEXT PRIMARY KEY,
      check_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      details TEXT,
      raw_data TEXT,
      executed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (check_id) REFERENCES checks(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS failure_events (
      id TEXT PRIMARY KEY,
      check_id TEXT NOT NULL,
      failure_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      title TEXT NOT NULL,
      description TEXT,
      raw_data TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (check_id) REFERENCES checks(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playbook_entries (
      id TEXT PRIMARY KEY,
      failure_type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_occurrence_at TEXT NOT NULL DEFAULT (datetime('now')),
      occurrence_count INTEGER NOT NULL DEFAULT 1
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      stripe_customer_id TEXT UNIQUE,
      email TEXT NOT NULL,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      stripe_subscription_id TEXT UNIQUE,
      plan_tier TEXT NOT NULL CHECK(plan_tier IN ('basic', 'advanced', 'white_glove')),
      status TEXT NOT NULL DEFAULT 'incomplete' CHECK(status IN ('incomplete', 'active', 'past_due', 'canceled', 'trialing', 'incomplete_expired')),
      current_period_start TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      metric TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS dependencies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      current_version TEXT NOT NULL,
      specified_range TEXT NOT NULL,
      is_dev INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS dependency_updates (
      id TEXT PRIMARY KEY,
      dependency_id TEXT NOT NULL,
      available_version TEXT NOT NULL,
      current_version TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('major', 'minor', 'patch', 'unknown')),
      is_breaking INTEGER NOT NULL DEFAULT 0,
      changelog_url TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (dependency_id) REFERENCES dependencies(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_log (
      id TEXT PRIMARY KEY,
      playbook_entry_id TEXT NOT NULL,
      failure_type TEXT NOT NULL,
      script TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'success', 'failed', 'skipped')),
      output TEXT,
      executed_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (playbook_entry_id) REFERENCES playbook_entries(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_actions (
      id TEXT PRIMARY KEY,
      failure_type TEXT NOT NULL,
      action_name TEXT NOT NULL,
      description TEXT,
      risk_level TEXT NOT NULL DEFAULT 'medium',
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

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
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS remediation_policies (
      id TEXT PRIMARY KEY,
      failure_type TEXT NOT NULL,
      auto_approve INTEGER NOT NULL DEFAULT 0,
      require_dry_run INTEGER NOT NULL DEFAULT 1,
      cooldown_minutes INTEGER NOT NULL DEFAULT 60,
      UNIQUE(failure_type)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_remediation_runs_status ON remediation_runs(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_remediation_runs_action ON remediation_runs(action_name)');
  db.run('CREATE INDEX IF NOT EXISTS idx_remediation_actions_failure ON remediation_actions(failure_type)');

  db.run(`
    CREATE TABLE IF NOT EXISTS perf_runs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed')),
      lcp REAL,
      tbt REAL,
      cls REAL,
      fcp REAL,
      inp REAL,
      score REAL,
      raw_output TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS perf_metrics (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'ms',
      score REAL,
      FOREIGN KEY (run_id) REFERENCES perf_runs(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS perf_regressions (
      id TEXT PRIMARY KEY,
      metric TEXT NOT NULL,
      current_value REAL NOT NULL,
      baseline_mean REAL NOT NULL,
      baseline_stddev REAL NOT NULL,
      p_value REAL NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('degradation', 'improvement')),
      trend TEXT NOT NULL DEFAULT 'declining' CHECK(trend IN ('improving', 'declining', 'stable')),
      url TEXT NOT NULL,
      run_id TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (run_id) REFERENCES perf_runs(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS perf_diagnoses (
      id TEXT PRIMARY KEY,
      regression_id TEXT NOT NULL,
      diagnosis TEXT NOT NULL,
      recommendation TEXT NOT NULL,
      impact TEXT NOT NULL CHECK(impact IN ('high', 'medium', 'low')),
      category TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (regression_id) REFERENCES perf_regressions(id)
    );
  `);

  return db;
}

export function saveDatabase(db: SqlJsDatabase, dbPath: string): void {
  const fs = require('fs');
  const path = require('path');
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}