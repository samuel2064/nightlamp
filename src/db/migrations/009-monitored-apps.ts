import type { Database } from 'sql.js';

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS monitored_apps (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
      url TEXT NOT NULL,
      platform TEXT NOT NULL CHECK(platform IN ('vercel', 'railway', 'heroku', 'aws', 'gcp', 'azure', 'custom')),
      check_type TEXT NOT NULL CHECK(check_type IN ('http', 'tcp', 'keyword')),
      check_target TEXT NOT NULL,
      check_interval_sec INTEGER NOT NULL DEFAULT 60 CHECK(check_interval_sec BETWEEN 10 AND 86400),
      check_timeout_sec INTEGER NOT NULL DEFAULT 10 CHECK(check_timeout_sec BETWEEN 1 AND 30),
      keyword TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      alert_channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (team_id) REFERENCES teams(id),
      FOREIGN KEY (alert_channel_id) REFERENCES alert_channels(id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS health_snapshots (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      team_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('pass', 'fail')),
      status_code INTEGER,
      latency_ms REAL NOT NULL,
      error_type TEXT,
      error_detail TEXT,
      checked_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (app_id) REFERENCES monitored_apps(id) ON DELETE CASCADE,
      FOREIGN KEY (team_id) REFERENCES teams(id)
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_monitored_apps_team ON monitored_apps(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_monitored_apps_channel ON monitored_apps(alert_channel_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_health_snapshots_team ON health_snapshots(team_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_health_snapshots_app ON health_snapshots(app_id, checked_at DESC)');
}

export function down(db: Database): void {
  db.run('DROP INDEX IF EXISTS idx_health_snapshots_app');
  db.run('DROP INDEX IF EXISTS idx_health_snapshots_team');
  db.run('DROP INDEX IF EXISTS idx_monitored_apps_channel');
  db.run('DROP INDEX IF EXISTS idx_monitored_apps_team');
  db.run('DROP TABLE IF EXISTS health_snapshots');
  db.run('DROP TABLE IF EXISTS monitored_apps');
}