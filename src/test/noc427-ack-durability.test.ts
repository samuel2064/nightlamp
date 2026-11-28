import assert from 'assert';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../db/schema';
// `src/test/setup.ts` (required globally by .mocharc.json) patches globalThis.fetch
// to attach a test bearer token to every localhost request, which would make this
// probe's reads authenticated and therefore mutating. The anonymous client keeps
// the evidence about the write path, not about the identity upsert.
import { fetchWithoutAuth } from './setup';

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(SERVER_ROOT, 'dist', 'index.js');
const PUBLISHED_BOUND_SECONDS = 2;

/**
 * NOC-427: an acknowledged write must be in the durable file at the
 * acknowledgement instant, so an immediate `SIGKILL` cannot lose it, and a
 * flush that cannot write the image must refuse the acknowledgement instead of
 * swallowing the error. The suite spawns the built server so the evidence is
 * the product entry point, not a handler called in-process.
 */
describe('NOC-427 flush before the acknowledgement (strict acknowledged-write durability)', () => {
  let workDir: string;
  const children: ChildProcess[] = [];

  function track(child: ChildProcess): ChildProcess {
    children.push(child);
    return child;
  }

  function spawnServer(extraEnv: Record<string, string>, entry: string = SERVER_ENTRY): ChildProcess {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
    // Keep the probe hermetic: no connector credentials, no Stripe, no Clerk.
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
        if (response.status === 200) {
          return await response.json() as any;
        }
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
    await new Promise((resolve) => prober.close(() => resolve()));
    return port;
  }

  /**
   * Boots the product entry point on a free port and waits for `/api/health`.
   * The port reservation can lose a race with a socket the OS has not released
   * yet, so a failed boot is retried on a fresh port with its log attached
   * before the case reports a failure.
   */
  async function bootServer(extraEnv: Record<string, string>): Promise<{ child: ChildProcess; port: number; health: any; log: string[] }> {
    const attempts: string[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const port = await reservePort();
      const log: string[] = [];
      const child = spawnServer({ ...extraEnv, PORT: String(port) });
      captureOutput(child, log);
      try {
        const health = await waitForHealth(port, 20000);
        return { child, port, health, log };
      } catch (err: any) {
        attempts.push(`port ${port}: ${err.message} :: ${log.join('').slice(-400)}`);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        await waitForExit(child, 5000);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`the server did not answer /api/health: ${attempts.join(' || ')}`);
  }

  async function postLead(port: number, email: string): Promise<any> {
    const response = await fetchWithoutAuth(`http://127.0.0.1:${port}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'noc427', name: 'NOC-427 Probe' }),
    });
    return { status: response.status, body: await response.json() as any };
  }

  /** Reads a copy of the file through the product's own loader. */
  async function readLeadEmails(dbPath: string): Promise<string[]> {
    const copyPath = `${dbPath}.probe-copy`;
    fs.copyFileSync(dbPath, copyPath);
    const reopened = await createDatabase(copyPath);
    try {
      const rows = reopened.exec('SELECT email FROM leads');
      return rows.length > 0 ? rows[0].values.map((row: any) => String(row[0])) : [];
    } finally {
      reopened.close();
      fs.rmSync(copyPath, { force: true });
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
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc427-'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  /**
   * The board's case, three runs: the acknowledgement answers, the image
   * already holds the row, and the process is killed with no chance to run a
   * handler. `PERSIST_INTERVAL_SEC` is set far above the probe so the bounded
   * timer cannot be what saves the row - the flush before the acknowledgement
   * has to be.
   */
  it('keeps an acknowledged write in the file across a SIGKILL at the acknowledgement instant (3 runs)', async function () {
    this.timeout(300000);
    for (let run = 0; run < 3; run += 1) {
      const dbPath = path.join(workDir, `ack-${run}.db`);
      const email = `noc427-ack-${run}-${uuidv4()}@example.com`;

      const { child, port, health } = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: '60' });
      assert.strictEqual(health.status, 'ok');
      assert.strictEqual(
        health.persistence?.persistIntervalSeconds,
        60,
        'the configured bound must stay published on /api/health (NOC-416)',
      );
      assert.ok(
        typeof health.persistence?.lastPersistedAt === 'string',
        'the boot image must already be persisted',
      );

      const written = await postLead(port, email);
      assert.strictEqual(written.status, 200, `run ${run}: the write must be acknowledged`);
      assert.strictEqual(written.body.success, true, `run ${run}: the acknowledgement body must be unchanged`);

      // Read the file at the acknowledgement instant: the row is already there,
      // before any kill and without waiting for the flush bound.
      const beforeKill = await readLeadEmails(dbPath);
      assert.ok(
        beforeKill.includes(email),
        `run ${run}: the acknowledged row must be in the file at the acknowledgement instant`,
      );

      // No file inspection between the 200 and the kill: the hard kill lands
      // immediately after the acknowledgement.
      child.kill('SIGKILL');
      await waitForExit(child, 10000);

      const afterKill = await readLeadEmails(dbPath);
      assert.ok(
        afterKill.includes(email),
        `run ${run}: the acknowledged row must survive a SIGKILL at the acknowledgement instant`,
      );

      const restart = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: '60' });
      assert.notStrictEqual(restart.health.bootId, health.bootId, `run ${run}: the restart must be genuine`);
      restart.child.kill('SIGKILL');
      await waitForExit(restart.child, 10000);

      const afterRestart = await readLeadEmails(dbPath);
      assert.ok(
        afterRestart.includes(email),
        `run ${run}: the acknowledged row must still be there after the restart`,
      );
    }
  });

  /**
   * Immediately after the acknowledgement and around the previous flush
   * boundary, on the published bound: the flush before the acknowledgement
   * makes the kill point irrelevant, which is exactly what the bounded route
   * could not promise at ~1.9 s.
   */
  it('keeps an acknowledged write in the file across a SIGKILL inside and past the flush window (6 runs)', async function () {
    this.timeout(420000);
    const killDelaysMs = [25, 1900];
    for (const killDelayMs of killDelaysMs) {
      for (let run = 0; run < 3; run += 1) {
        const dbPath = path.join(workDir, `window-${killDelayMs}-${run}.db`);
        const email = `noc427-window-${killDelayMs}-${run}-${uuidv4()}@example.com`;

        const started = await bootServer({
          DB_PATH: dbPath,
          PERSIST_INTERVAL_SEC: String(PUBLISHED_BOUND_SECONDS),
        });
        assert.strictEqual(
          started.health.persistence?.persistIntervalSeconds,
          PUBLISHED_BOUND_SECONDS,
          'the published bound must stay on /api/health (NOC-416)',
        );

        const written = await postLead(started.port, email);
        assert.strictEqual(written.status, 200, 'the write must be acknowledged');

        await new Promise((resolve) => setTimeout(resolve, killDelayMs));
        started.child.kill('SIGKILL');
        await waitForExit(started.child, 10000);

        const afterKill = await readLeadEmails(dbPath);
        assert.ok(
          afterKill.includes(email),
          `kill at +${killDelayMs}ms run ${run}: the acknowledged row must survive a SIGKILL ${killDelayMs}ms after the acknowledgement`,
        );

        const restart = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: '60' });
        restart.child.kill('SIGKILL');
        await waitForExit(restart.child, 10000);

        const afterRestart = await readLeadEmails(dbPath);
        assert.ok(
          afterRestart.includes(email),
          `kill at +${killDelayMs}ms run ${run}: the acknowledged row must still be there after the restart`,
        );
      }
    }
  });

  /**
   * The residual the bounded route carried: `flush()` swallowed a save failure,
   * so an acknowledgement could name a write that never reached the file. Here
   * the file's parent directory is replaced by a plain file, which makes the
   * atomic write fail on every platform, and the acknowledgement must refuse
   * with HTTP 500 `PERSISTENCE_FAILED` - no success body, no id - while the
   * health endpoint keeps answering 200 and the writable control answers 200
   * with the id.
   */
  it('refuses the acknowledgement with 500 PERSISTENCE_FAILED when the image cannot be written', async function () {
    this.timeout(300000);
    const dbPath = path.join(workDir, 'unwritable.db');
    const dataDir = path.dirname(dbPath);
    const email = `noc427-refuse-${uuidv4()}@example.com`;

    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: '60' });
    assert.strictEqual(started.health.status, 'ok');

    // The health surface is a read: it must keep answering while the durable
    // write is broken, so the failure is scoped to the mutating path.
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.writeFileSync(dataDir, 'not a directory', 'utf8');
    const healthStillOk = await waitForHealth(started.port, 8000).catch((err: any) => {
      throw new Error(`${err.message} :: server log: ${started.log.join('').slice(-800)}`);
    });
    assert.strictEqual(healthStillOk.status, 'ok', 'a read must not be refused by a broken durable write');

    const refused = await postLead(started.port, email);
    assert.strictEqual(refused.status, 500, 'an acknowledgement that cannot be persisted must be refused');
    assert.strictEqual(refused.body.error, 'persistence failed');
    assert.strictEqual(refused.body.code, 'PERSISTENCE_FAILED');
    assert.strictEqual(refused.body.success, undefined, 'a refused write must carry no success flag');
    assert.strictEqual(refused.body.id, undefined, 'a refused write must carry no id');

    // The refusal must not be sticky: once the directory is writable again the
    // same route acknowledges a write and the row lands in the file. A second
    // address is used because the route refuses a duplicate email with 409,
    // which is its own contract and not this gate's.
    fs.rmSync(dataDir, { force: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const recoveredEmail = `noc427-recovered-${uuidv4()}@example.com`;
    const recovered = await postLead(started.port, recoveredEmail);
    assert.strictEqual(recovered.status, 200, 'the route must acknowledge again once the write lands');
    assert.strictEqual(recovered.body.success, true);
    const emails = await readLeadEmails(dbPath);
    assert.ok(emails.includes(recoveredEmail), 'the recovered write must be in the file');

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });

  /**
   * The writable control: with the directory intact the same route answers 200
   * with the id, so the refusal above is caused by the failed write and not by
   * a change in the route's contract.
   */
  it('acknowledges a write with the unchanged body when the image can be written', async function () {
    this.timeout(180000);
    const dbPath = path.join(workDir, 'control.db');
    const email = `noc427-control-${uuidv4()}@example.com`;

    const started = await bootServer({ DB_PATH: dbPath, PERSIST_INTERVAL_SEC: '60' });

    const written = await postLead(started.port, email);
    assert.strictEqual(written.status, 200);
    assert.strictEqual(written.body.success, true);
    assert.strictEqual(typeof written.body.id, 'string', 'the acknowledgement body must be unchanged');
    const emails = await readLeadEmails(dbPath);
    assert.ok(emails.includes(email), 'the write must be in the file at the acknowledgement instant');

    started.child.kill('SIGKILL');
    await waitForExit(started.child, 10000);
  });
});
