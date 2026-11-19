import * as fs from 'fs';
import * as path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { applySchema } from './schema';

export type StorageMode = 'sqlite' | 'postgres';

let bootId = generateBootId();

function generateBootId(): string {
  return `boot-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export function getBootId(): string {
  return bootId;
}

export function resetBootId(): void {
  bootId = generateBootId();
}

export async function createDatabase(dbPathOrUrl?: string): Promise<{ db: SqlJsDatabase; mode: StorageMode }> {
  const databaseUrl = process.env.DATABASE_URL || dbPathOrUrl;
  
  if (databaseUrl && databaseUrl.startsWith('postgres')) {
    // For now, fall back to sqlite. Full postgres support requires more work.
    console.warn('[Nightlamp] DATABASE_URL detected but PostgreSQL support is not yet implemented. Falling back to SQLite.');
  }
  
  const dbPath = databaseUrl || './data/nightlamp.db';
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  if (fs.existsSync(dbPath)) {
    const data = fs.readFileSync(dbPath);
    const loaded = new SQL.Database(new Uint8Array(data));
    applySchema(loaded);
    return { db: loaded, mode: 'sqlite' };
  }
  
  applySchema(db);
  return { db, mode: 'sqlite' };
}

export function saveDatabase(db: SqlJsDatabase, dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}