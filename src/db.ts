import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

const DEFAULT_DB_PATH = join(process.cwd(), 'nightlamp.db')

let db: SqlJsDatabase | null = null
let currentDbPath: string = DEFAULT_DB_PATH

export async function initDb(dbPath?: string): Promise<SqlJsDatabase> {
  const path = dbPath || DEFAULT_DB_PATH
  currentDbPath = path
  const SQL = await initSqlJs()

  if (path !== ':memory:' && existsSync(path)) {
    const buffer = readFileSync(path)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }

  db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_customer_id TEXT UNIQUE,
    email TEXT NOT NULL,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    stripe_subscription_id TEXT UNIQUE,
    plan_tier TEXT NOT NULL CHECK(plan_tier IN ('watch', 'respond', 'white_glove')),
    status TEXT NOT NULL DEFAULT 'incomplete'
      CHECK(status IN ('incomplete', 'active', 'past_due', 'canceled', 'trialing', 'incomplete_expired')),
    current_period_start TEXT,
    current_period_end TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL,
    monitors_used INTEGER DEFAULT 0,
    reports_generated INTEGER DEFAULT 0,
    storage_mb REAL DEFAULT 0,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    current_version TEXT NOT NULL,
    latest_version TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('dependencies', 'devDependencies', 'peerDependencies')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS dependency_updates (
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
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS playbook_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    failure_type TEXT NOT NULL,
    source TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('critical', 'high', 'medium', 'low')),
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    affected_resource TEXT NOT NULL,
    diagnosis TEXT NOT NULL DEFAULT '',
    remediation TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'investigating', 'resolved', 'dismissed')),
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_detected_at TEXT NOT NULL,
    last_detected_at TEXT NOT NULL,
    resolved_at TEXT,
    related_entries TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`)

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_playbook_failure_source ON playbook_entries(failure_type, source)`)

  db.run(`CREATE INDEX IF NOT EXISTS idx_dep_updates_detected ON dependency_updates(detected_at)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_dep_updates_severity ON dependency_updates(severity)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_dep_updates_breaking ON dependency_updates(breaking)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_dep_updates_dep_id ON dependency_updates(dependency_id)`)

  db.run(`CREATE TABLE IF NOT EXISTS dependency_health_snapshots (
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
  )`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_health_snapshots_at ON dependency_health_snapshots(snapshot_at)`)

  db.run(`CREATE TABLE IF NOT EXISTS dependency_alert_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_name TEXT NOT NULL,
    rule_type TEXT NOT NULL CHECK(rule_type IN ('breaking', 'outdated', 'security', 'all')),
    min_severity TEXT NOT NULL DEFAULT 'medium' CHECK(min_severity IN ('critical', 'high', 'medium', 'low')),
    channel TEXT NOT NULL DEFAULT 'slack' CHECK(channel IN ('slack', 'webhook', 'email', 'all')),
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(package_name, rule_type)
  )`)

  if (path !== ':memory:') saveDb()
  return db
}

export function getDb(): SqlJsDatabase {
  if (!db) throw new Error('Database not initialized. Call initDb() first.')
  return db
}

export function saveDb(): void {
  if (!db || currentDbPath === ':memory:') return
  const data = db.export()
  const buffer = Buffer.from(data)
  writeFileSync(currentDbPath, buffer)
}

export function resetDb(): void {
  db = null
  currentDbPath = DEFAULT_DB_PATH
}