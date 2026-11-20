import { Database } from 'sql.js';

export function up(db: Database): void {
  // Add team_id column to perf_runs for tenant scoping
  db.run(`ALTER TABLE perf_runs ADD COLUMN team_id TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_runs_team ON perf_runs(team_id)`);

  // Add team_id column to perf_regressions for tenant scoping
  db.run(`ALTER TABLE perf_regressions ADD COLUMN team_id TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_regressions_team ON perf_regressions(team_id)`);
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_perf_runs_team`);
  db.run(`DROP INDEX IF NOT EXISTS idx_perf_regressions_team`);
}