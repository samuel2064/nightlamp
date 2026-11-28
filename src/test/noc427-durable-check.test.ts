import assert from 'assert';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import initSqlJs from 'sql.js';
import { saveDatabase } from '../db/schema';
// `src/test/setup.ts` (required globally by .mocharc.json) patches globalThis.fetch
// to attach a test bearer token to every localhost request, which would make the
// durability answer come from a path that also mutates. The anonymous client keeps
// the probe exactly the shape a deploy gate uses: no credential, no identity row.
import { fetchWithoutAuth } from './setup';

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(SERVER_ROOT, 'dist', 'index.js');
const PROBE_BOUND_SECONDS = 60;
const LEAD_LIST_PATH = '/api/leads';
const PROBE_PATH = '/api/health/durability-check';

/**
 * A deploy gate's marker: `nl-dur-<32 hex>@durability.invalid`. The lowercase hex
 * is what the route stores, so the value is generated rather than typed.
 */
function makeMarker(): string {
  return `nl-dur-${crypto.randomBytes(16).toString('hex')}@durability.invalid`;
}

/**
 * NOC-432: the product half of the deploy gate's durability evidence. The gate
 * runs on a GitHub runner with no access to the Render mount, so the read-back
 * has to be published by the product - and it has to come from the durable file,
 * because the API serves one in-memory image it never re-reads and an answer
 * from memory would prove nothing about the file.
 *
 * The decisive case writes a marker through the acknowledged lead path, removes
 * that row from the durable file behind the running process's back, and asserts
 * the probe answers `present: false` while the API's own in-memory image still
 * holds the row. An answer that came from memory would answer `true` there.
 */
describe('NOC-432 the file-derived durability probe', () => {
  let workDir: string;
  const children: ChildProcess[] = [];

  function track(child: ChildProcess): ChildProcess {
    children.push(child);
    return child;
  }

  function spawnServer(extraEnv: Record<string, string>, entry: string = SERVER_ENTRY): ChildProcess {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
    for (const key of [
      'DATABASE_URL', 'SENTRY_AUTH_TOKEN', 'SENTRY_ORG_SLUG', 'SENTRY_PROJECT_SLUG',
      'UPTIMEROBOT_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
      'X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_POST_ON_STARTUP',
    ]) {
      delete childEnv[key];
    }
    Object.assign(childEnv, extraEnv);
    return track(spawn(process.execPath, [entry], {
      cwd: SERVER_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
  }

  function captureOutput(child: ChildProcess, sink: string[]): void {
    child.stdout.on('data', (chunk) => sink.push(String(chunk)));
    child.stderr.on('data', (chunk) => sink.push(String(chunk)));
  }

  function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  async function waitForHealth(port: number, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const response = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/health`);
        if (response.status === 200) return await response.json() as any;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        throw new Error(`the server on port ${port} did not answer /api/health within ${timeoutMs}ms`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function reservePort(): Promise<number> {
    const prober = net.createServer();
    await new Promise<void>((resolve, reject) => {
      prober.once('error', reject);
      prober.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (prober.address() as any).port;
    await new Promise<void>((resolve) => prober.close(() => resolve()));
    return port;
  }

  async function bootServer(extraEnv: Record<string, string>): Promise<{ child: ChildProcess; port: number; log: string[] }> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = await reservePort();
      const log: string[] = [];
      const child = spawnServer({ ...extraEnv, PORT: String(port) });
      captureOutput(child, log);
      try {
        await waitForHealth(port, 20000);
        return { child, port, log };
      } catch (err: any) {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await waitForExit(child, 5000);
        if (attempt === 2) throw new Error(`the server did not boot: ${err.message} :: ${log.join('').slice(-400)}`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error('unreachable');
  }

  /** Writes a marker through the public lead capture, the acknowledged path a gate uses. */
  async function writeMarker(port: number, marker: string): Promise<any> {
    const response = await fetchWithoutAuth(`http://127.0.0.1:${port}${LEAD_LIST_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: marker, source: 'deploy-storage-gate', name: 'Durability marker' }),
    });
    return { status: response.status, body: await response.json() as any };
  }

  async function probeDurability(port: number, marker?: string): Promise<{ status: number; body: any }> {
    const url = marker
      ? `http://127.0.0.1:${port}${PROBE_PATH}?marker=${encodeURIComponent(marker)}`
      : `http://127.0.0.1:${port}${PROBE_PATH}`;
    const response = await fetchWithoutAuth(url);
    let body: any = {};
    try { body = await response.json() as any; } catch { /* a refusal body is still parsed by status */ }
    return { status: response.status, body };
  }

  /**
   * The witness that the probe's answer is not memory-derived: the lead route
   * checks its duplicate against the in-memory image, so a second write of a
   * marker the image still holds is refused with 409 even though the durable
   * file no longer carries it. (The read-back list needs a credential, so it is
   * not a usable public witness.)
   */
  async function imageStillHoldsMarker(port: number, marker: string): Promise<boolean> {
    const response = await fetchWithoutAuth(`http://127.0.0.1:${port}${LEAD_LIST_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: marker, source: 'deploy-storage-gate', name: 'Durability marker' }),
    });
    return response.status === 409;
  }

  /**
   * Removes the row from the durable file behind the running process's back. The
   * process keeps serving its in-memory image, so this is exactly the state a
   * memory-derived answer would get wrong.
   */
  async function removeLeadFromFile(dbPath: string, email: string): Promise<void> {
    const SQL = await initSqlJs();
    const db = new SQL.Database(fs.readFileSync(dbPath));
    try {
      db.run('DELETE FROM leads WHERE email = ?', [email]);
      saveDatabase(db, dbPath);
    } finally {
      db.close();
    }
  }

  function ensureBuiltServer(): void {
    let newestSrc = 0;
    const walk = (dir: string) => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else newestSrc = Math.max(newestSrc, fs.statSync(full).mtimeMs);
      }
    };
    walk(path.join(SERVER_ROOT, 'src'));
    if (!fs.existsSync(SERVER_ENTRY) || fs.statSync(SERVER_ENTRY).mtimeMs < newestSrc) {
      execSync('npx tsc', { cwd: SERVER_ROOT, stdio: 'pipe' });
    }
  }

  beforeEach(() => {
    ensureBuiltServer();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc432-'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * The decisive case. The marker is acknowledged through the lead capture, the
   * probe answers `present: true` against the file, the row is then removed from
   * the file while the process keeps serving its in-memory image, and the probe
   * must answer `present: false` - proving the answer is file-derived, since the
   * API's own list still shows the row.
   */
  it('answers from the durable file, not from the in-memory image', async function () {
    this.timeout(300000);
    const dbPath = path.join(workDir, 'durable.db');
    const marker = makeMarker();
    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: String(PROBE_BOUND_SECONDS) });

    const written = await writeMarker(started.port, marker);
    assert.strictEqual(written.status, 200, 'the marker write must be acknowledged');
    assert.strictEqual(written.body.success, true, 'the acknowledgement body must be unchanged');

    // Control: the row the API acknowledged is in the durable file.
    const before = await probeDurability(started.port, marker);
    assert.strictEqual(before.status, 200, `the probe must answer 200: ${JSON.stringify(before.body)}`);
    assert.strictEqual(before.body.status, 'ok');
    assert.strictEqual(before.body.marker, marker, 'the probe must echo the marker it was asked about');
    assert.strictEqual(before.body.present, true, 'the acknowledged marker must be in the durable file');
    assert.strictEqual(before.body.source, 'file', 'the answer must be declared file-derived');
    assert.strictEqual(before.body.databasePath, dbPath, 'the probe must name the file it read');
    assert.ok(
      Number.isInteger(before.body.databaseBytes) && before.body.databaseBytes > 0,
      `the probe must name the size of the file it read: ${JSON.stringify(before.body.databaseBytes)}`,
    );
    assert.ok(
      typeof before.body.checkedAt === 'string' && !Number.isNaN(Date.parse(before.body.checkedAt)),
      'the probe must carry the time it answered',
    );
    assert.ok(
      typeof before.body.readMs === 'number' && before.body.readMs >= 0,
      'the probe must carry the cost of its read',
    );

    // The row is removed from the file while the process keeps serving its image.
    await removeLeadFromFile(dbPath, marker);

    const after = await probeDurability(started.port, marker);
    assert.strictEqual(after.status, 200, `the probe must still answer 200: ${JSON.stringify(after.body)}`);
    assert.strictEqual(
      after.body.present,
      false,
      'a row removed from the durable file must answer present:false - an answer from the in-memory image would answer true here',
    );
    assert.strictEqual(after.body.source, 'file', 'the answer must stay declared file-derived');

    // The witness that the answer is not memory-derived: the in-memory image still
    // holds the row the process acknowledged, so a second write of the same
    // marker is refused as a duplicate - while the file-derived probe above
    // answers present:false. The two surfaces disagree by design.
    assert.strictEqual(
      await imageStillHoldsMarker(started.port, marker),
      true,
      'the in-memory image must still hold the acknowledged row, which is what makes present:false evidence',
    );

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });

  /** A marker the product never wrote is absent from a file it did read. */
  it('answers present:false for a marker that was never written', async function () {
    this.timeout(180000);
    const dbPath = path.join(workDir, 'absent.db');
    const marker = makeMarker();
    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: String(PROBE_BOUND_SECONDS) });

    const result = await probeDurability(started.port, marker);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.present, false, 'a marker nobody wrote is absent');
    assert.strictEqual(result.body.source, 'file');

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });

  /** The marker shape is a token, so anything else is refused before the file is opened. */
  it('refuses a malformed marker with 400 before the file is opened', async function () {
    this.timeout(180000);
    const dbPath = path.join(workDir, 'markers.db');
    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: String(PROBE_BOUND_SECONDS) });
    const validHex = crypto.randomBytes(16).toString('hex');

    const cases: Array<{ label: string; marker: string | undefined }> = [
      { label: 'no marker at all', marker: undefined },
      { label: 'an empty marker', marker: '' },
      { label: 'the wrong prefix', marker: `nl-other-${validHex}@durability.invalid` },
      { label: 'the wrong suffix', marker: `nl-dur-${validHex}@other.invalid` },
      { label: 'too short a hex body', marker: `nl-dur-${validHex.slice(0, 8)}@durability.invalid` },
      { label: 'too long a hex body', marker: `nl-dur-${validHex}ff@durability.invalid` },
      { label: 'an upper-case hex body', marker: `nl-dur-${validHex.toUpperCase()}@durability.invalid` },
      { label: 'a non-hex body', marker: 'nl-dur-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz@durability.invalid' },
      { label: 'a probe attempt against another table', marker: "' OR 1=1 --" },
    ];

    for (const testCase of cases) {
      const result = await probeDurability(started.port, testCase.marker);
      assert.strictEqual(result.status, 400, `${testCase.label} must be refused with 400`);
      assert.strictEqual(
        result.body.error,
        'invalid durability marker',
        `${testCase.label} must name the refusal`,
      );
    }

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });

  /**
   * A file that cannot be read is not an absent write. Answering
   * `present: false` would name the wrong cause and send an operator hunting a
   * phantom lost write, so the probe fails with 500 instead.
   */
  it('fails with 500 rather than present:false when the durable file cannot be read', async function () {
    this.timeout(180000);
    const dbPath = path.join(workDir, 'unreadable.db');
    const marker = makeMarker();
    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: String(PROBE_BOUND_SECONDS) });

    const written = await writeMarker(started.port, marker);
    assert.strictEqual(written.status, 200, 'the write must be acknowledged before the file disappears');

    fs.rmSync(dbPath, { force: true });

    const result = await probeDurability(started.port, marker);
    assert.strictEqual(result.status, 500, `an unreadable file must fail the check: ${JSON.stringify(result.body)}`);
    assert.strictEqual(result.body.error, 'durability check failed', 'the failure must name the unreadable file');
    assert.notStrictEqual(result.body.present, false, 'the probe must never answer present:false for a file it could not read');

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });

  /** The cost a deploy gate pays per check, measured against a real image. */
  it('reads the durable file fast enough for a deploy gate', async function () {
    this.timeout(180000);
    const dbPath = path.join(workDir, 'cost.db');
    const marker = makeMarker();
    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: String(PROBE_BOUND_SECONDS) });

    await writeMarker(started.port, marker);
    const samples: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const result = await probeDurability(started.port, marker);
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.present, true);
      samples.push(result.body.readMs);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    assert.ok(
      median < 500,
      `a durability check must stay well inside a deploy gate's budget, measured median ${median}ms over ${samples.length} checks`,
    );
    process.stdout.write(`[noc432] durability check readMs samples=${JSON.stringify(samples)} median=${median}\n`);

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });
});
