import { Database } from 'sql.js';

export function up(db: Database): void {
  db.run(`ALTER TABLE playbook_executions ADD COLUMN team_id TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_playbook_executions_team ON playbook_executions(team_id)`);
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_playbook_executions_team`);
}