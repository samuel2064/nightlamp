import { createDatabase, saveDatabase } from './schema';
import { getDatabaseConfig, getStorageMode, isProduction, getBootId, bootId, createConnection, shouldWarnAboutEphemeralStorage, getPersistentMountPath, type DatabaseConfig, type StorageMode, type DatabaseConnection } from './connection';

export { createDatabase, saveDatabase };
export { getDatabaseConfig, getStorageMode, isProduction, getBootId, bootId, createConnection, shouldWarnAboutEphemeralStorage, getPersistentMountPath };
export type { NightlampDb } from './schema';
export type { DatabaseConfig, StorageMode, DatabaseConnection };