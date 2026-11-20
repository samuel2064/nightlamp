import { Database } from 'sql.js';

export function up(db: Database): void {
  // Add team_id column to leads for tenant scoping
  // This is additive - existing rows will have NULL team_id and remain invisible per NOC-319
  db.run(`ALTER TABLE leads ADD COLUMN team_id TEXT`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_leads_team ON leads(team_id)`);
}

export function down(db: Database): void {
  db.run(`DROP INDEX IF EXISTS idx_leads_team`);
}