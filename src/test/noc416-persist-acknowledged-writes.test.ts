import assert from 'assert';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../db/schema';

const SERVER_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_ENTRY = path.join(SERVER_ROOT, 'dist', 'index.js');
const PUBLISHED_BOUND_SECONDS = 2;

/**
 * NOC-416: an acknowledged write must reach the database file within a bounded
 * interval, a graceful SIGTERM must flush it, and /api/health must describe the
 * adapter actually serving the process. The suite spawns the built server so
 * the evidence is the product entry point, not a handler called in-process.
 */
describe('NOC-416 persist acknowledged writes (bounded flush + SIGTERM)', () => {
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
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
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
    await new Promise<void>((resolve) => prober.close(() => resolve()));
    return port;
  }

  async function postLead(port: number, email: string): Promise<any> {
    const response = await fetch(`http://127.0.0.1:${port}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, source: 'noc416', name: 'NOC-416 Probe' }),
    });
    return { status: response.status, body: await response.json() as any };
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
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc416-'));
  });

  afterEach(() => {
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('persists an acknowledged write within the published bound across a hard kill', async function () {
    this.timeout(120000);
    const dbPath = path.join(workDir, 'durable.db');
    const port = await reservePort();
    const email = `noc416-${uuidv4()}@example.com`;

    const child = spawnServer({ DB_PATH: dbPath, PORT: String(port), PERSIST_INTERVAL_SEC: String(PUBLISHED_BOUND_SECONDS) });
    const firstHealth = await waitForHealth(port, 60000);
    assert.strictEqual(firstHealth.status, 'ok');

    const bound = firstHealth.persistence?.persistIntervalSeconds;
    assert.strictEqual(bound, PUBLISHED_BOUND_SECONDS, 'the bound must be published on /api/health');
    const beforeWrite = firstHealth.persistence?.lastPersistedAt;
    assert.ok(typeof beforeWrite === 'string', 'the boot image must already be persisted');

    const written = await postLead(port, email);
    assert.strictEqual(written.status, 200, 'the write must be acknowledged');
    assert.strictEqual(written.body.success, true);

    // The write must reach the file within the published bound; the probe
    // allows one extra interval of scheduling slack and no more.
    const deadline = Date.now() + (bound * 1000) + 5000;
    let persistedAt: string | null = null;
    for (;;) {
      const health = await waitForHealth(port, 5000);
      if (health.persistence?.lastPersistedAt && health.persistence.lastPersistedAt !== beforeWrite) {
        persistedAt = health.persistence.lastPersistedAt;
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`the acknowledged write did not reach ${dbPath} within the published ${bound}s bound`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(!Number.isNaN(Date.parse(persistedAt)), 'lastPersistedAt must be a timestamp');

    // Hard kill: on every platform this terminates the process with no chance
    // to run a handler, so only the bounded flush can have saved the row.
    child.kill('SIGKILL');
    await waitForExit(child, 10000);

    assert.ok(fs.existsSync(dbPath), 'the database file must exist after the bounded flush');

    const freshPort = await reservePort();
    const fresh = spawnServer({ DB_PATH: dbPath, PORT: String(freshPort), PERSIST_INTERVAL_SEC: String(PUBLISHED_BOUND_SECONDS) });
    const secondHealth = await waitForHealth(freshPort, 60000);
    assert.notStrictEqual(secondHealth.bootId, firstHealth.bootId, 'the second process must be a genuine restart');
    fresh.kill('SIGKILL');
    await waitForExit(fresh, 10000);

    const reopened = await createDatabase(dbPath);
    try {
      const rows = reopened.exec('SELECT id, email FROM leads WHERE email = ?', [email]);
      assert.strictEqual(rows[0].values.length, 1, 'the acknowledged write must survive the restart');
    } finally {
      reopened.close();
    }
  });

  it('flushes the image on SIGTERM before exit', async function () {
    this.timeout(120000);
    const dbPath = path.join(workDir, 'sigterm.db');
    const port = await reservePort();
    const email = `noc416-sigterm-${uuidv4()}@example.com`;

    // Relay process: it loads the built server and, on a trigger file, emits the
    // SIGTERM signal in-process. Windows delivers no POSIX signal to a child
    // process (the child is terminated outright), so the registered listener is
    // driven the only way it can run on this platform.
    const relayPath = path.join(workDir, 'sigterm-relay.cjs');
    const triggerFile = path.join(workDir, 'trigger');
    fs.writeFileSync(relayPath, [
      "const fs = require('fs');",
      "require(process.env.NOC416_SERVER_ENTRY);",
      "const timer = setInterval(() => {",
      "  if (fs.existsSync(process.env.NOC416_TRIGGER_FILE)) {",
      "    clearInterval(timer);",
      "    process.emit('SIGTERM');",
      "  }",
      "}, 50);",
      '',
    ].join('\n'), 'utf8');

    const child = spawnServer(
      {
        DB_PATH: dbPath,
        PORT: String(port),
        PERSIST_INTERVAL_SEC: '60',
        NOC416_SERVER_ENTRY: SERVER_ENTRY,
        NOC416_TRIGGER_FILE: triggerFile,
      },
      relayPath,
    );
    await waitForHealth(port, 60000);

    const written = await postLead(port, email);
    assert.strictEqual(written.status, 200, 'the write must be acknowledged');

    fs.writeFileSync(triggerFile, 'go', 'utf8');
    const exitCode = await waitForExit(child, 20000);
    assert.strictEqual(exitCode, 0, 'the SIGTERM handler must exit cleanly');

    // The 60s interval cannot have fired, so only the shutdown flush saved it.
    assert.ok(fs.existsSync(dbPath), 'the SIGTERM handler must flush the image before exit');

    const freshPort = await reservePort();
    const fresh = spawnServer({ DB_PATH: dbPath, PORT: String(freshPort), PERSIST_INTERVAL_SEC: '60' });
    await waitForHealth(freshPort, 60000);
    fresh.kill('SIGKILL');
    await waitForExit(fresh, 10000);

    const reopened = await createDatabase(dbPath);
    try {
      const rows = reopened.exec('SELECT id, email FROM leads WHERE email = ?', [email]);
      assert.strictEqual(rows[0].values.length, 1, 'the write must survive a SIGTERM shutdown and restart');
    } finally {
      reopened.close();
    }
  });

  it('reports the storage adapter actually in use on /api/health', async function () {
    this.timeout(120000);
    const dbPath = path.join(workDir, 'honesty.db');
    const port = await reservePort();

    // A URL where nothing listens. Boot never selects the Postgres adapter on
    // this tree, so the health endpoint must not claim postgres.
    const child = spawnServer({
      DB_PATH: dbPath,
      PORT: String(port),
      DATABASE_URL: 'postgresql://nightlamp:nightlamp@127.0.0.1:1/nightlamp',
      PERSIST_INTERVAL_SEC: String(PUBLISHED_BOUND_SECONDS),
    });
    const health = await waitForHealth(port, 60000);

    assert.strictEqual(health.storageMode, 'sqlite', 'health must not report postgres while the sql.js adapter serves requests');
    assert.strictEqual(health.persistence.persistIntervalSeconds, PUBLISHED_BOUND_SECONDS);
    assert.ok(typeof health.persistence.lastPersistedAt === 'string', 'the boot image must be persisted');

    child.kill('SIGKILL');
    await waitForExit(child, 10000);
  });
});