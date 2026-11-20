import type { Database } from 'sql.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

export function up(db: Database): void {
  if (!hasColumn(db, 'playbook_executions', 'team_id')) {
    db.run(`ALTER TABLE playbook_executions ADD COLUMN team_id TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_playbook_executions_team ON playbook_executions(team_id)`);
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_playbook_executions_team`);
  if (hasColumn(db, 'playbook_executions', 'team_id')) {
    db.run(`ALTER TABLE playbook_executions DROP COLUMN team_id`);
  }
}