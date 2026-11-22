import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

export type StorageMode = 'sqlite' | 'postgres';

export interface DatabaseConfig {
  mode: StorageMode;
  sqlitePath?: string;
  databaseUrl?: string;
}

export interface DatabaseConnection {
  db: SqlJsDatabase | PostgresAdapter;
  mode: StorageMode;
  close(): Promise<void>;
  persist(): Promise<void>;
}

export interface PostgresAdapter {
  exec(sql: string): Promise<any>;
  run(sql: string, params?: any[]): Promise<void>;
  prepare(sql: string): PostgresPreparedStatement;
}

export interface PostgresPreparedStatement {
  run(...params: any[]): Promise<void>;
  all(...params: any[]): Promise<any[]>;
  get(...params: any[]): Promise<any>;
}

let pgModule: any = null;

async function loadPg(): Promise<any> {
  if (!pgModule) {
    try {
      pgModule = await import('pg');
    } catch (error) {
      throw new Error('PostgreSQL support requires the "pg" package. Run: npm install pg');
    }
  }
  return pgModule;
}

export async function createConnection(config: DatabaseConfig): Promise<DatabaseConnection> {
  if (config.mode === 'postgres') {
    return createPostgresConnection(config.databaseUrl!);
  }
  return createSqliteConnection(config.sqlitePath!);
}

async function createSqliteConnection(dbPath: string): Promise<DatabaseConnection> {
  const initSqlJs = (await import('sql.js')).default;
  const SQL = await initSqlJs();
  let db: SqlJsDatabase;

  if (dbPath && fs.existsSync(dbPath)) {
    const persisted = fs.readFileSync(dbPath);
    db = new SQL.Database(persisted);
  } else {
    db = new SQL.Database();
  }

  return {
    db,
    mode: 'sqlite',
    async close() {
      // No-op for sqlite
    },
    async persist() {
      if (!dbPath) return;
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const buffer = Buffer.from(db.export());
      const tempPath = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
      let fileDescriptor: number | null = null;
      try {
        fileDescriptor = fs.openSync(tempPath, 'wx');
        fs.writeFileSync(fileDescriptor, buffer);
        fs.fsyncSync(fileDescriptor);
        fs.closeSync(fileDescriptor);
        fileDescriptor = null;
        fs.renameSync(tempPath, dbPath);
      } catch (error) {
        if (fileDescriptor !== null) {
          fs.closeSync(fileDescriptor);
        }
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
        throw error;
      }
    },
  };
}

async function createPostgresConnection(databaseUrl: string): Promise<DatabaseConnection> {
  const pg = await loadPg();
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();

  // Run PostgreSQL migrations
  await runPostgresMigrations(pool);

  const adapter: PostgresAdapter = {
    async exec(sql: string) {
      const result = await client.query(sql);
      return result.rows.length > 0 ? [{ columns: Object.keys(result.rows[0]), values: result.rows.map((r: any) => Object.values(r)) }] : [];
    },
    async run(sql: string, params?: any[]) {
      await client.query(sql, params);
    },
    prepare(sql: string) {
      return {
        async run(...params: any[]) {
          await client.query(sql, params);
        },
        async all(...params: any[]) {
          const result = await client.query(sql, params);
          return result.rows;
        },
        async get(...params: any[]) {
          const result = await client.query(sql, params);
          return result.rows[0] || null;
        },
      };
    },
  };

  return {
    db: adapter,
    mode: 'postgres',
    async close() {
      client.release();
      await pool.end();
    },
    async persist() {
      // No-op for postgres, transactions are committed automatically
    },
  };
}

async function runPostgresMigrations(pool: any): Promise<void> {
  // Import and run the postgres migrations in order
  const { up: up009 } = await import('./migrations/009-postgres-setup');
  await up009(pool);
  const { up: up010 } = await import('./migrations/010-extend-plan-tier-check');
  await up010(pool);
}

export function getStorageMode(config: DatabaseConfig): StorageMode {
  return config.mode;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
}

// Boot ID generated once at module scope - this is the actual boot ID for the process
export const bootId: string = `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;

export function getBootId(): string {
  return bootId;
}

export function getDatabaseConfig(): DatabaseConfig {
  const databaseUrl = process.env.DATABASE_URL;
  const dbPath = process.env.DB_PATH || './data/nightlamp.db';

  if (databaseUrl) {
    return { mode: 'postgres', databaseUrl };
  }
  return { mode: 'sqlite', sqlitePath: dbPath };
}

export const DEFAULT_PERSISTENT_MOUNT_PATH = '/mnt/data';
export const DATABASE_FILE_NAME = 'nightlamp.db';

export function getPersistentMountPath(): string {
  const configured = process.env.PERSISTENT_MOUNT_PATH || DEFAULT_PERSISTENT_MOUNT_PATH;
  return configured.replace(/\/+$/, '');
}

export function getExpectedDatabasePath(): string {
  return `${getPersistentMountPath()}/${DATABASE_FILE_NAME}`;
}

export function shouldWarnAboutEphemeralStorage(config: DatabaseConfig): string | null {
  if (!isProduction() || config.mode !== 'sqlite') {
    return null;
  }
  const persistentMountPath = getPersistentMountPath();
  const isOnPersistentVolume = config.sqlitePath && config.sqlitePath.startsWith(persistentMountPath);
  if (isOnPersistentVolume) {
    return null;
  }
  return `WARNING: Running in production with SQLite file storage on local container filesystem. Data will be lost on restart/deploy! DB_PATH must point at the mounted disk at ${getExpectedDatabasePath()}.`;
}