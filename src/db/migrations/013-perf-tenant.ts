import type { Database } from 'sql.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

export function up(db: Database): void {
  // Add team_id column to perf_runs for tenant scoping
  if (!hasColumn(db, 'perf_runs', 'team_id')) {
    db.run(`ALTER TABLE perf_runs ADD COLUMN team_id TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_runs_team ON perf_runs(team_id)`);

  // Add team_id column to perf_regressions for tenant scoping
  if (!hasColumn(db, 'perf_regressions', 'team_id')) {
    db.run(`ALTER TABLE perf_regressions ADD COLUMN team_id TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_regressions_team ON perf_regressions(team_id)`);

  // Add team_id column to perf_diagnoses for tenant scoping
  if (!hasColumn(db, 'perf_diagnoses', 'team_id')) {
    db.run(`ALTER TABLE perf_diagnoses ADD COLUMN team_id TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_diagnoses_team ON perf_diagnoses(team_id)`);
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_perf_runs_team`);
  db.run(`DROP INDEX IF EXISTS idx_perf_regressions_team`);
  db.run(`DROP INDEX IF EXISTS idx_perf_diagnoses_team`);
  if (hasColumn(db, 'perf_runs', 'team_id')) {
    db.run(`ALTER TABLE perf_runs DROP COLUMN team_id`);
  }
  if (hasColumn(db, 'perf_regressions', 'team_id')) {
    db.run(`ALTER TABLE perf_regressions DROP COLUMN team_id`);
  }
  if (hasColumn(db, 'perf_diagnoses', 'team_id')) {
    db.run(`ALTER TABLE perf_diagnoses DROP COLUMN team_id`);
  }
}