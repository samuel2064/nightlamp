import path from 'path';
import { createDatabase, saveDatabase } from '../src/db/schema';

export const VERIFICATION_TEAM_PREFIX = 'noc263-verify-';

export interface CleanupResult {
  teams: string[];
  deletedRows: number;
}

function tableNames(db: { exec(sql: string, params?: any[]): any[] }): string[] {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  return result.length > 0 ? result[0].values.map((row: any) => row[0] as string) : [];
}

function columnNames(db: { exec(sql: string, params?: any[]): any[] }, table: string): string[] {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result.length > 0 ? result[0].values.map((row: any) => row[1] as string) : [];
}

export function cleanupVerificationTeams(
  db: { run(sql: string, params?: any[]): any; exec(sql: string, params?: any[]): any[] },
  prefix: string = VERIFICATION_TEAM_PREFIX,
): CleanupResult {
  const found = db.exec('SELECT id, slug FROM teams WHERE slug LIKE ?', [`${prefix}%`]);
  const teams = found.length > 0 ? found[0].values.map((row: any) => row[0] as string) : [];
  if (teams.length === 0) {
    return { teams: [], deletedRows: 0 };
  }

  const placeholders = teams.map(() => '?').join(', ');
  let deletedRows = 0;

  db.run('PRAGMA foreign_keys = OFF');
  try {
    for (const table of tableNames(db)) {
      const columns = columnNames(db, table);
      const teamColumn = columns.includes('team_id')
        ? 'team_id'
        : columns.includes('created_team_id')
          ? 'created_team_id'
          : null;
      if (!teamColumn) continue;
      db.run(`DELETE FROM ${table} WHERE ${teamColumn} IN (${placeholders})`, teams);
      deletedRows += db.getRowsModified();
    }

    db.run(`DELETE FROM teams WHERE id IN (${placeholders})`, teams);
    deletedRows += db.getRowsModified();
  } finally {
    db.run('PRAGMA foreign_keys = ON');
  }

  return { teams, deletedRows };
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH || './data/nightlamp.db';
  const prefix = process.env.VERIFICATION_TEAM_PREFIX || VERIFICATION_TEAM_PREFIX;
  const db = await createDatabase(dbPath);
  const result = cleanupVerificationTeams(db, prefix);
  saveDatabase(db, dbPath);
  console.log(JSON.stringify({
    database: path.resolve(dbPath),
    prefix,
    deletedTeams: result.teams.length,
    deletedRows: result.deletedRows,
  }));
}

if (require.main === module) {
  main().catch((err: any) => {
    console.error(err?.message || String(err));
    process.exit(1);
  });
}
