import { createDatabase, saveDatabase } from './schema';
import { getDatabaseConfig, getStorageMode, isProduction, getBootId, bootId, createConnection, type DatabaseConfig, type StorageMode, type DatabaseConnection } from './connection';

export { createDatabase, saveDatabase };
export { getDatabaseConfig, getStorageMode, isProduction, getBootId, bootId, createConnection };
export type { NightlampDb } from './schema';
export type { DatabaseConfig, StorageMode, DatabaseConnection };