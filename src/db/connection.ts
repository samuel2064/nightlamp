import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { Pool } from 'pg';
import { up as pgUp } from './migrations/012-postgres-setup';

export type StorageMode = 'sqlite' | 'postgres';

export interface DatabaseConfig {
  mode: StorageMode;
  sqlitePath?: string;
  databaseUrl?: string;
}

export interface DatabaseConnection {
  db: SqlJsDatabase | any;
  mode: StorageMode;
  close(): Promise<void>;
  persist(): Promise<void>;
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

  const fs = await import('fs');
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
      const path = await import('path');
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

  // Run PostgreSQL migrations
  await pgUp(pool);

  const client = await pool.connect();
  
  const db = {
    async exec(sql: string) {
      const result = await client.query(sql);
      return result.rows.length > 0 ? [{ columns: Object.keys(result.rows[0]), values: result.rows.map((r: any) => Object.values(r)) }] : [];
    },
    async run(sql: string, params?: any[]) {
      await client.query(sql, params);
    },
    async prepare(sql: string) {
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
    db,
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

export function getStorageMode(config: DatabaseConfig): StorageMode {
  return config.mode;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
}

export function getBootId(): string {
  // Generate a unique boot ID for this process
  return `${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
}