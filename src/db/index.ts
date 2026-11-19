import { createDatabase, saveDatabase } from './schema';
import { createDatabase as createDatabaseWithUrl, getBootId, saveDatabase as saveDatabaseWithMode, StorageMode } from './connection';

export { createDatabase, saveDatabase, createDatabaseWithUrl, getBootId, saveDatabaseWithMode, StorageMode };