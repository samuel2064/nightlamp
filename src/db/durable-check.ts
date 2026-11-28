import * as fs from 'fs';
import initSqlJs from 'sql.js';
import { getSqliteDatabasePath } from './connection';

/**
 * The product half of the deploy gate's durability evidence (NOC-432).
 *
 * The gate runs on a GitHub runner with no access to the Render mount, and the
 * API serves one in-memory sql.js image it never re-reads, so a durability
 * answer that came from memory would prove nothing about the file. This module
 * reads the durable file on disk and answers from those bytes.
 */

/** The marker a gate writes through the public lead capture, and nothing else. */
const MARKER_PREFIX = 'nl-dur-';
const MARKER_SUFFIX = '@durability.invalid';
const MARKER_HEX = /^[0-9a-f]{32}$/;

export interface DurableCheckResult {
  present: boolean;
  checkedAt: string;
  /** Always "file": the answer is derived from the durable file, never from memory. */
  source: 'file';
  databasePath: string;
  databaseBytes: number | null;
  readMs: number;
}

export class InvalidMarkerError extends Error {
  constructor() {
    super('invalid durability marker');
    this.name = 'InvalidMarkerError';
  }
}

/**
 * A marker is `nl-dur-<32 hex>@durability.invalid`. The fixed shape keeps the
 * value a token the caller generated rather than a string it can use to probe
 * the store, so anything else is refused before the file is opened.
 */
export function isValidMarker(marker: unknown): marker is string {
  if (typeof marker !== 'string') return false;
  if (!marker.startsWith(MARKER_PREFIX) || !marker.endsWith(MARKER_SUFFIX)) return false;
  const hex = marker.slice(MARKER_PREFIX.length, marker.length - MARKER_SUFFIX.length);
  return MARKER_HEX.test(hex);
}

function assertMarker(marker: unknown): asserts marker is string {
  if (!isValidMarker(marker)) throw new InvalidMarkerError();
}

/**
 * The loaded sql.js module, kept for the process. Instantiating the wasm is the
 * dominant cost of a check at a small image, and this endpoint exists to be
 * called on every deploy, so the instance is paid for once.
 */
let sqlModule: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function loadSqlModule() {
  if (!sqlModule) {
    sqlModule = await initSqlJs();
  }
  return sqlModule;
}

/**
 * Opens the durable file fresh and answers whether a row carries the marker.
 *
 * Every failure to read the file is an error the caller turns into a 500: a
 * `present: false` answer is reserved for a file that was read and does not
 * hold the marker, so an unreadable file can never be reported as "the write is
 * not there" - which would name the wrong cause and send an operator hunting a
 * phantom lost write.
 */
export async function checkDurableFile(
  dbPath: string,
  marker: unknown,
): Promise<DurableCheckResult> {
  assertMarker(marker);
  const started = process.hrtime.bigint();
  const bytes = fs.readFileSync(dbPath);
  const SQL = await loadSqlModule();
  const db = new SQL.Database(bytes);
  let present = false;
  try {
    const rows = db.exec(
      'SELECT id FROM leads WHERE email = ? AND team_id IS NULL',
      [marker],
    );
    present = rows.length > 0 && rows[0].values.length > 0;
  } finally {
    db.close();
  }
  return {
    present,
    checkedAt: new Date().toISOString(),
    source: 'file',
    databasePath: dbPath,
    databaseBytes: bytes.length,
    readMs: Number(process.hrtime.bigint() - started) / 1e6,
  };
}

/** The sqlite path this process writes, resolved through the one default the boot reads. */
export function durableDatabasePath(): string {
  return getSqliteDatabasePath();
}
