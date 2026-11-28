import { createHash } from 'crypto';
import * as fs from 'fs';
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
  /**
   * sha256 of the durable file's bytes, read back from the file itself after
   * the last flush that derived it (NOC-427). It describes the file the writer
   * produced rather than the image the writer held, so a deploy gate running on
   * a machine that cannot reach the mount can still verify that an
   * acknowledged write reached the file.
   */
  lastPersistedImageDigest: string | null;
  /** Byte length of the file the digest above describes. */
  lastPersistedImageBytes: number | null;
}

export interface FlushOptions {
  /**
   * Read the durable file back and derive `lastPersistedImageDigest` /
   * `lastPersistedImageBytes` from its bytes. The acknowledgement gate asks for
   * it so every acknowledged write publishes the file-derived fact that proves
   * it landed; the timer and the boot flush leave it alone so the idle path
   * stays a single write.
   */
  deriveFileFact?: boolean;
}

export interface PersistenceController {
  start(): void;
  stop(): void;
  /**
   * Writes the whole image to the file and reports whether it landed. The
   * boolean is the strict contract (NOC-427): an acknowledgement may only be
   * sent when the write is in the file, so a flush that could not complete the
   * atomic write must be observable by the caller instead of swallowed.
   */
  flush(options?: FlushOptions): boolean;
  getStatus(): PersistenceStatus;
}

/**
 * Controllers this process created, keyed by the database instance they write.
 * The API layer resolves the flush from the `db` it was started with, so the
 * acknowledgement gate is bound to the image the request actually mutated and no
 * wiring crosses `src/index.ts`.
 */
const controllersByDatabase = new WeakMap<SqlJsDatabase, PersistenceController>();

export function getPersistenceControllerForDatabase(db: SqlJsDatabase): PersistenceController | null {
  return controllersByDatabase.get(db) ?? null;
}

/**
 * Bounded writer for the sql.js image. A repeating timer persists the whole
 * image with the existing atomic temp-file + rename write in `saveDatabase`, so
 * a write that belongs to no request (the health-check cron, the notification
 * and remediation engines) still reaches `DB_PATH` within
 * `persistIntervalSeconds`. `flush()` is the same write and is what the signal
 * handlers, the boot and the NOC-427 acknowledgement gate call.
 *
 * Under the strict criterion (NOC-427) `flush()` additionally runs **before**
 * the acknowledgement of a mutating request and reports whether the image
 * landed, so an HTTP 2xx means the write is in the file. The interval timer is
 * retained unchanged (the issue's contract keeps the bounded background
 * flush): a mutating request is therefore written once before its
 * acknowledgement and again by the timer.
 *
 * The acknowledgement flush also derives the file-derived digest (`A1` in the
 * plan's section 2u): the bytes are read back from the file and hashed, so a
 * gate that cannot reach the mount can still tell an acknowledged write apart
 * from an idle rewrite that produced a byte-identical image.
 */

export function createPersistenceController(db: SqlJsDatabase, dbPath: string): PersistenceController {
  const intervalSeconds = getPersistIntervalSeconds();
  let timer: NodeJS.Timeout | null = null;
  let lastPersistedAt: string | null = null;
  let lastPersistedImageDigest: string | null = null;
  let lastPersistedImageBytes: number | null = null;

  function flush(options: FlushOptions = {}): boolean {
    try {
      saveDatabase(db, dbPath);
      lastPersistedAt = new Date().toISOString();
      if (options.deriveFileFact) {
        // Describe the bytes that landed in the file, not the bytes the writer
        // meant to write: a flush that reports success but leaves the file
        // unchanged must not be able to answer the gate's question.
        const written = fs.readFileSync(dbPath);
        lastPersistedImageDigest = createHash('sha256').update(written).digest('hex');
        lastPersistedImageBytes = written.length;
      }
      return true;
    } catch (err: any) {
      // The error is reported, never swallowed into a success: the caller turns
      // a failed flush into a failed acknowledgement (NOC-427).
      console.error(`[Nightlamp] Failed to persist the database image to ${dbPath}: ${err.message}`);
      return false;
    }
  }

  const controller: PersistenceController = {
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
      return {
        persistIntervalSeconds: intervalSeconds,
        lastPersistedAt,
        lastPersistedImageDigest,
        lastPersistedImageBytes,
      };
    },
  };

  controllersByDatabase.set(db, controller);
  return controller;
}
