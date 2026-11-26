import { createDatabase, saveDatabase } from './schema';
import { getDatabaseConfig, getStorageMode, isProduction, getBootId, bootId, createConnection, describeActiveStorageMode, shouldWarnAboutEphemeralStorage, getPersistentMountPath, getExpectedDatabasePath, DEFAULT_PERSISTENT_MOUNT_PATH, type DatabaseConfig, type StorageMode, type DatabaseConnection } from './connection';
import { createPersistenceController, getPersistIntervalSeconds, DEFAULT_PERSIST_INTERVAL_SEC, type PersistenceController, type PersistenceStatus } from './persistence';

export { createDatabase, saveDatabase };
export { getDatabaseConfig, getStorageMode, isProduction, getBootId, bootId, createConnection, describeActiveStorageMode, shouldWarnAboutEphemeralStorage, getPersistentMountPath, getExpectedDatabasePath, DEFAULT_PERSISTENT_MOUNT_PATH };
export { createPersistenceController, getPersistIntervalSeconds, DEFAULT_PERSIST_INTERVAL_SEC };
export type { PersistenceController, PersistenceStatus };
export type { NightlampDb } from './schema';
export type { DatabaseConfig, StorageMode, DatabaseConnection };