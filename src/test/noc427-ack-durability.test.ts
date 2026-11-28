import assert from 'assert';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase, saveDatabase } from '../db/schema';
// `src/test/setup.ts` (required globally by .mocharc.json) patches globalThis.fetch
// to attach a test bearer token to every localhost request, which would make this
// probe's reads authenticated and therefore mutating. The anonymous client keeps
// the evidence about the write path, not about the identity upsert.
import { fetchWithoutAuth } from './setup';
import { installAcknowledgementGate } from '../api/server';

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

/**
 * NOC-427: the atomic write's temp name. The acknowledgement gate turns a failed
 * flush into a refused acknowledgement, so a save that fails for a reason the
 * caller did not cause becomes a customer-visible 500 for an image that would
 * have persisted. The temp file is opened with `wx` (exclusive) and used to be
 * named `${dbPath}.${pid}.${Date.now()}.tmp`, so a file of that shape already
 * present in the directory - the remains of a save that was interrupted before
 * its rename - made the next write of that same millisecond fail with EEXIST.
 * The name now carries a per-process salt and a monotone counter, so no
 * pre-existing name can refuse a durable write.
 *
 * Measured: on the base object this case fails with `EEXIST` (the save throws
 * before the rename), and on this head the image lands.
 */
describe('NOC-427 the atomic save names each write its own temp file', () => {
  let saveDir: string;

  beforeEach(() => {
    saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc427-save-'));
  });

  afterEach(() => {
    fs.rmSync(saveDir, { recursive: true, force: true });
  });

  it('persists an image when a same-shape temp file is already present', async function () {
    this.timeout(60000);
    const dbPath = path.join(saveDir, 'temp-collision.db');
    const db = await createDatabase(dbPath);
    const realNow = Date.now;
    try {
      Date.now = () => 1700000000000;
      // The name the previous scheme would have used for this process and this
      // millisecond, left behind by a save that never reached its rename.
      const staleTemp = `${dbPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(staleTemp, 'interrupted before the rename');
      try {
        saveDatabase(db, dbPath);
      } finally {
        Date.now = realNow;
      }
      assert.ok(fs.existsSync(dbPath), 'the image must exist even though the old temp name was taken');
      // The stale file is not this write's, so it is not removed by this write.
      const leftovers = fs.readdirSync(saveDir).filter((name) => name.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [path.basename(staleTemp)], 'only the interrupted file may remain');
    } finally {
      Date.now = realNow;
      db.close();
    }
  });

  it('names each write of one frozen millisecond its own temp file and leaves nothing behind', async function () {
    this.timeout(60000);
    const dbPath = path.join(saveDir, 'temp-unique.db');
    const db = await createDatabase(dbPath);
    const realNow = Date.now;
    try {
      Date.now = () => 1700000000000;
      try {
        saveDatabase(db, dbPath);
        saveDatabase(db, dbPath);
        saveDatabase(db, dbPath);
      } finally {
        Date.now = realNow;
      }
      assert.ok(fs.existsSync(dbPath), 'the image must exist after the saves');
      const leftovers = fs.readdirSync(saveDir).filter((name) => name.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'no temporary file may be left behind');
    } finally {
      Date.now = realNow;
      db.close();
    }
  });
});

/**
 * NOC-427: the gate's own acknowledgement points, measured on the gate rather
 * than through a route. The tree ships no route that answers with an implicit
 * head (`res.write` / `res.flushHeaders` with no preceding `res.writeHead`), so
 * the paths the CTO's audit found uncovered are exercised directly: the first
 * write and the header flush must both flush the image before any success
 * status can reach the client.
 */
describe('NOC-427 the acknowledgement gate on an implicit head', () => {
  function fakeResponse(): { res: any; calls: string[] } {
    const calls: string[] = [];
    const res: any = {
      statusCode: 200,
      writeHead: (statusCode: any) => { calls.push(`head:${statusCode}`); return res; },
      flushHeaders: () => { calls.push('flushHeaders'); },
      write: (chunk: any) => { calls.push(`write:${String(chunk).slice(0, 12)}`); return true; },
      end: (chunk?: any) => { calls.push(`end:${chunk === undefined ? '' : String(chunk).slice(0, 12)}`); return res; },
    };
    return { res, calls };
  }

  /** A baseline of -1 reads the module's counter (which starts at 0) as "this request mutated". */
  const MUTATED_BASELINE = -1;

  it('flushes the image before the first write puts the 200 head on the wire', () => {
    const { res, calls } = fakeResponse();
    let flushes = 0;
    installAcknowledgementGate(res, MUTATED_BASELINE, () => { flushes += 1; return true; });

    const written = res.write('chunk-one');

    assert.strictEqual(written, true, 'a successful acknowledgement must still write the route\'s body');
    assert.deepStrictEqual(calls, ['write:chunk-one'], 'no head of the response\'s own may precede the flush');
    assert.strictEqual(flushes, 1, 'the first write is an acknowledgement point, so the image is written before it');
  });

  it('refuses an implicit-head acknowledgement with 500 PERSISTENCE_FAILED when the flush fails', () => {
    const { res, calls } = fakeResponse();
    installAcknowledgementGate(res, MUTATED_BASELINE, () => false);

    res.write('chunk-one');

    assert.deepStrictEqual(
      calls,
      ['head:500', 'end:{"error":"pe'],
      'the refusal must write the 500 head and body and suppress the route\'s own frames',
    );
  });

  it('flushes the image before res.flushHeaders() sends the head', () => {
    const { res, calls } = fakeResponse();
    let flushes = 0;
    installAcknowledgementGate(res, MUTATED_BASELINE, () => { flushes += 1; return true; });

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.flushHeaders();

    assert.strictEqual(flushes, 1, 'the head is an acknowledgement point, so the image is written before it is flushed');
    assert.deepStrictEqual(calls, ['head:200', 'flushHeaders']);
  });

  it('leaves a response that acknowledged no mutation untouched', () => {
    const { res, calls } = fakeResponse();
    let flushes = 0;
    // A baseline the counter never reaches: the request performed no mutation.
    installAcknowledgementGate(res, Number.MAX_SAFE_INTEGER, () => { flushes += 1; return true; });

    res.write('chunk-one');
    res.end('done');

    assert.strictEqual(flushes, 0, 'a request that acknowledged no write must not pay a save');
    assert.deepStrictEqual(calls, ['write:chunk-one', 'end:done']);
  });
});

/**
 * NOC-427: the acknowledgement gate's safety rests on one premise - every
 * request-serving mutation reaches the shared sql.js image through `db.run`,
 * which the gate counts, and every read goes through `db.exec`, which it does
 * not count. The premise held by measurement before this delivery and nothing
 * enforced it, so it is enforced here.
 *
 * The census classifies every `.exec(` call in `src/` outside `src/test/`: the
 * SQL is taken from the call's first argument, and a variable argument is
 * resolved through its assignment in the same file. A site whose SQL cannot be
 * resolved at all is counted, not guessed, so a new one fails the run and is
 * read by a human instead of slipping through.
 */
describe('NOC-427 the request-surface mutation census', () => {
  const MUTATING_KEYWORD = /^(insert|update|delete|create|alter|drop|replace|attach|detach|vacuum|reindex)\b/i;

  function collectFiles(dir: string, into: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'test') continue;
        collectFiles(full, into);
      } else if (entry.name.endsWith('.ts')) {
        into.push(full);
      }
    }
    return into;
  }

  /** The first argument of a call at `openParen`, balanced across lines. */
  function firstArgument(text: string, openParen: number): string {
    let depth = 0;
    let buffer = '';
    for (let i = openParen; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      if (depth > 1 || (depth === 1 && i > openParen)) buffer += ch;
    }
    let bracket = 0;
    let quote: string | null = null;
    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') bracket += 1;
      if (ch === ')' || ch === ']' || ch === '}') bracket -= 1;
      if (ch === ',' && bracket === 0) return buffer.slice(0, i).trim();
    }
    return buffer.trim();
  }

  function sqlKeyword(sqlText: string): string {
    const sql = sqlText.replace(/^\s*['"`]/, '').replace(/\s+/g, ' ').trim();
    return sql.split(/[\s(]/)[0] || '(empty)';
  }

  interface Site {
    where: string;
    arg: string;
    verdict: 'read' | 'mutating' | 'unresolved';
  }

  function census(): { sites: Site[]; execSites: number; runSites: number } {
    const files = collectFiles(path.resolve(__dirname, '..'));
    const sites: Site[] = [];
    let execSites = 0;
    let runSites = 0;

    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      execSites += (text.match(/\.exec\(/g) || []).length;
      runSites += (text.match(/\.run\(/g) || []).length;
      const lines = text.split('\n');
      const lineStarts: number[] = [];
      let offset = 0;
      for (const line of lines) {
        lineStarts.push(offset);
        offset += line.length + 1;
      }

      for (let index = 0; index < lines.length; index += 1) {
        let from = 0;
        for (;;) {
          const found = lines[index].indexOf('.exec(', from);
          if (found < 0) break;
          from = found + 6;
          const arg = firstArgument(text, lineStarts[index] + found + 5);
          const relative = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
          const where = `${relative}:${index + 1}`;
          const literal = arg.match(/^(['"`])([\s\S]*)\1$/);
          if (literal) {
            const keyword = sqlKeyword(literal[2]);
            sites.push({ where, arg: keyword, verdict: MUTATING_KEYWORD.test(keyword) ? 'mutating' : 'read' });
            continue;
          }
          if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
            const declaration = new RegExp(`(?:let|const|var)\\s+${arg}\\s*(?::[^=]+)?=\\s*([\\s\\S]*?);`, 'm').exec(text);
            const declaredLiteral = declaration && declaration[1].trim().match(/^(['"`])([\s\S]*)\1$/);
            if (declaredLiteral) {
              const keyword = sqlKeyword(declaredLiteral[2]);
              sites.push({ where, arg: keyword, verdict: MUTATING_KEYWORD.test(keyword) ? 'mutating' : 'read' });
              continue;
            }
          }
          sites.push({ where, arg: 'unresolved', verdict: 'unresolved' });
        }
      }
    }
    return { sites, execSites, runSites };
  }

  it('carries no mutating statement on the read path (the premise of the mutation counter)', () => {
    const { sites, execSites, runSites } = census();
    const mutating = sites.filter((site) => site.verdict === 'mutating');
    assert.strictEqual(
      mutating.length,
      0,
      `every request-serving mutation must go through db.run, which the gate counts.\n` +
      `mutating .exec( sites: ${mutating.map((site) => `${site.where} -> ${site.arg}`).join(', ')}\n` +
      `(measured on this head: ${execSites} .exec( and ${runSites} .run( sites in src/ outside src/test/)`,
    );
  });

  it('has no unresolvable read statement beyond the one pinned site', () => {
    const { sites } = census();
    const unresolved = sites.filter((site) => site.verdict === 'unresolved');
    assert.strictEqual(
      unresolved.length,
      1,
      `a new .exec( whose SQL cannot be read from its own file must be classified by a human.\n` +
      `unresolved sites: ${unresolved.map((site) => site.where).join(', ')}`,
    );
    assert.ok(
      unresolved[0].where.startsWith('src/billing/billing-api.ts'),
      'the one pinned unresolved site reads its SQL from an array of SELECT literals in the same file',
    );
  });
});
