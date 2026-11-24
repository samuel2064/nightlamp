import type { Database } from 'sql.js';

function hasColumn(db: Database, table: string, column: string): boolean {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 && result[0].values.some((row: any) => row[1] === column);
}

export function up(db: Database): void {
  // Add team_id column to leads for tenant scoping
  // This is additive - existing rows will have NULL team_id and remain invisible per NOC-319
  if (!hasColumn(db, 'leads', 'team_id')) {
    db.run(`ALTER TABLE leads ADD COLUMN team_id TEXT`);
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_leads_team ON leads(team_id)`);
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_leads_team`);
  if (hasColumn(db, 'leads', 'team_id')) {
    db.run(`ALTER TABLE leads DROP COLUMN team_id`);
  }
}