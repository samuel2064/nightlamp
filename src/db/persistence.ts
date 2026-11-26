import { Database as SqlJsDatabase } from 'sql.js';
import { saveDatabase } from './schema';

/**
 * Default bound (seconds) between an acknowledged write and the database image
 * reaching the file (NOC-416). The API serves from an in-memory sql.js image, so
 * without a bounded flush nothing reaches `DB_PATH` until a save cron fires.
 */
export const DEFAULT_PERSIST_INTERVAL_SEC = 2;

/**
 * Resolves the published persistence bound. The environment override is clamped
 * to at least one second so a misconfiguration cannot mean "never persist".
 */
export function getPersistIntervalSeconds(): number {
  const raw = parseInt(process.env.PERSIST_INTERVAL_SEC || '', 10);
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_PERSIST_INTERVAL_SEC;
  }
  return Math.min(raw, 3600);
}

export interface PersistenceStatus {
  persistIntervalSeconds: number;
  lastPersistedAt: string | null;
}

export interface PersistenceController {
  start(): void;
  stop(): void;
  flush(): void;
  getStatus(): PersistenceStatus;
}

/**
 * Bounded writer for the sql.js image. A repeating timer persists the whole
 * image with the existing atomic temp-file + rename write in `saveDatabase`, so
 * an acknowledged write reaches the file within `persistIntervalSeconds`.
 * `flush()` is the same write and is what the signal handlers call before exit.
 */
export function createPersistenceController(db: SqlJsDatabase, dbPath: string): PersistenceController {
  const intervalSeconds = getPersistIntervalSeconds();
  let timer: NodeJS.Timeout | null = null;
  let lastPersistedAt: string | null = null;

  function flush(): void {
    try {
      saveDatabase(db, dbPath);
      lastPersistedAt = new Date().toISOString();
    } catch (err: any) {
      console.error(`[Nightlamp] Failed to persist the database image to ${dbPath}: ${err.message}`);
    }
  }

  return {
    start() {
      if (timer) return;
      // Persist the boot image first so the file exists before the API answers,
      // then keep the bound. The timer is deliberately not unref'd: the
      // durability path must keep this process alive until a final flush.
      flush();
      timer = setInterval(flush, intervalSeconds * 1000);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    flush,
    getStatus() {
      return { persistIntervalSeconds: intervalSeconds, lastPersistedAt };
    },
  };
}