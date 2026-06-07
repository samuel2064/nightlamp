import type { Database } from 'sql.js'

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      current_version TEXT NOT NULL,
      latest_version TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('dependencies', 'devDependencies', 'peerDependencies')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS dependency_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dependency_id INTEGER NOT NULL,
      from_version TEXT NOT NULL,
      to_version TEXT NOT NULL,
      change_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      detected_at TEXT DEFAULT (datetime('now')),
      breaking INTEGER NOT NULL DEFAULT 0,
      summary TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (dependency_id) REFERENCES dependencies(id)
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS dependency_health_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      total_dependencies INTEGER NOT NULL,
      up_to_date INTEGER NOT NULL,
      outdated INTEGER NOT NULL,
      critical_count INTEGER NOT NULL DEFAULT 0,
      high_count INTEGER NOT NULL DEFAULT 0,
      medium_count INTEGER NOT NULL DEFAULT 0,
      low_count INTEGER NOT NULL DEFAULT 0,
      breaking_count INTEGER NOT NULL DEFAULT 0,
      snapshot_at TEXT DEFAULT (datetime('now'))
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS dependency_alert_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name TEXT NOT NULL,
      rule_type TEXT NOT NULL CHECK(rule_type IN ('breaking', 'outdated', 'security', 'all')),
      min_severity TEXT NOT NULL DEFAULT 'medium' CHECK(min_severity IN ('critical', 'high', 'medium', 'low')),
      channel TEXT NOT NULL DEFAULT 'slack' CHECK(channel IN ('slack', 'webhook', 'email', 'all')),
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(package_name, rule_type)
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_dep_updates_detected ON dependency_updates(detected_at)')
  db.run('CREATE INDEX IF NOT EXISTS idx_dep_updates_severity ON dependency_updates(severity)')
  db.run('CREATE INDEX IF NOT EXISTS idx_dep_updates_breaking ON dependency_updates(breaking)')
  db.run('CREATE INDEX IF NOT EXISTS idx_dep_updates_dep_id ON dependency_updates(dependency_id)')
  db.run('CREATE INDEX IF NOT EXISTS idx_health_snapshots_at ON dependency_health_snapshots(snapshot_at)')
}

export function down(db: Database): void {
  db.run('DROP TABLE IF EXISTS dependency_alert_rules')
  db.run('DROP TABLE IF EXISTS dependency_health_snapshots')
  db.run('DROP TABLE IF EXISTS dependency_updates')
  db.run('DROP TABLE IF EXISTS dependencies')
}
