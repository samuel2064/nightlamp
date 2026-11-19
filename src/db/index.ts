import { createDatabase as createSqliteDatabase, saveDatabase as saveSqliteDatabase } from './schema';
import { createConnection, getStorageMode, isProduction, getBootId, type DatabaseConfig, type StorageMode } from './connection';

export type { NightlampDb } from './schema';
export type { DatabaseConfig, StorageMode };
export { getStorageMode, isProduction, getBootId };

let currentConfig: DatabaseConfig = {
  mode: 'sqlite',
  sqlitePath: process.env.DB_PATH || './data/nightlamp.db',
};

if (process.env.DATABASE_URL) {
  currentConfig = {
    mode: 'postgres',
    databaseUrl: process.env.DATABASE_URL,
  };
}

export function getDatabaseConfig(): DatabaseConfig {
  return currentConfig;
}

export function setDatabaseConfig(config: DatabaseConfig): void {
  currentConfig = config;
}

export async function createDatabase(dbPath?: string): Promise<any> {
  if (currentConfig.mode === 'postgres') {
    const conn = await createConnection(currentConfig);
    return conn.db;
  }
  return createSqliteDatabase(dbPath || currentConfig.sqlitePath || './data/nightlamp.db');
}

export async function saveDatabase(db: any, dbPath?: string): Promise<void> {
  if (currentConfig.mode === 'postgres') {
    // PostgreSQL uses transactions, no need to explicitly save
    return;
  }
  saveSqliteDatabase(db, dbPath || currentConfig.sqlitePath || './data/nightlamp.db');
}