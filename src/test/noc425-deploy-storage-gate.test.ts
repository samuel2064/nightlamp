import assert from 'assert';
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'deploy-storage-gate.mjs');

interface GateResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ControlledHealth {
  [key: string]: unknown;
}

type DurableCheckMode = 'present' | 'absent' | 'missing' | 'not-file' | 'unreadable' | 'refused';

interface ProductServerOptions {
  durableCheck?: DurableCheckMode;
  leadWrite?: 'ok' | 'refused';
  refusalStatus?: 401 | 403;
}

const MARKER_PATTERN = /^nl-dur-[0-9a-f]{32}@durability\.invalid$/;

function durableHealth(): ControlledHealth {
  return {
    status: 'ok',
    storageMode: 'sqlite',
    configuredStorageMode: 'sqlite',
    storagePath: '/mnt/data/nightlamp.db',
    persistentMountPath: '/mnt/data',
    build: { commit: null, branch: null, source: 'unset' },
    persistence: {
      persistIntervalSeconds: 2,
      lastPersistedAt: '2026-11-26T12:00:00.000Z',
      storageOnPersistentMount: true,
      // The exact shape the product publishes at the release object: the mount
      // identity carries no file path and no expected path, and the verdict is
      // the device decision the gate reads.
      durableFile: {
        fileExists: true,
        fileDevice: '8:64',
        parentDevice: '8:64',
        rootDevice: '0:144',
        resolvedMountPoint: '/mnt/data',
        onExpectedMountDevice: true,
        mountInfoReadable: true,
        sameDeviceAsRoot: false,
      },
    },
  };
}

function durableFileOf(health: ControlledHealth): Record<string, unknown> {
  return (health.persistence as Record<string, unknown>).durableFile as Record<string, unknown>;
}

function runGate(first: ControlledHealth, second?: ControlledHealth, extraArgs: string[] = []): GateResult {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noc425-gate-'));
  try {
    const firstPath = path.join(dir, 'health-1.json');
    fs.writeFileSync(firstPath, JSON.stringify(first));
    const files = [firstPath];
    if (second !== undefined) {
      const secondPath = path.join(dir, 'health-2.json');
      fs.writeFileSync(secondPath, JSON.stringify(second));
      files.push(secondPath);
    }
    const result = spawnSync(process.execPath, [GATE_SCRIPT, ...files, ...extraArgs], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runGateAsync(args: string[]): Promise<GateResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GATE_SCRIPT, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startHealthServer(
  health: ControlledHealth,
  advanceFlush: boolean,
  options: ProductServerOptions = {}
): Promise<{ url: string; leadMarkers: string[]; close: () => Promise<void> }> {
  const durableCheck = options.durableCheck ?? 'present';
  const leadWrite = options.leadWrite ?? 'ok';
  return new Promise((resolve) => {
    let requests = 0;
    const leadMarkers: string[] = [];
    const sockets = new Set<import('net').Socket>();
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && requestUrl.pathname === '/api/leads') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          if (leadWrite === 'refused') {
            res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' });
            res.end(JSON.stringify({ error: 'refused' }));
            return;
          }
          let parsed: { email?: unknown } = {};
          try {
            parsed = JSON.parse(body) as { email?: unknown };
          } catch {
            parsed = {};
          }
          if (typeof parsed.email === 'string') {
            leadMarkers.push(parsed.email);
          }
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ success: true, id: 'lead-under-test' }));
        });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/health/durability-check') {
        if (durableCheck === 'missing') {
          res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        if (durableCheck === 'not-file') {
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ present: true, source: 'memory' }));
          return;
        }
        if (durableCheck === 'unreadable') {
          res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: 'durability check failed' }));
          return;
        }
        if (durableCheck === 'refused') {
          // The shape the product's own authorization gate answers with on a
          // build that does not publish the probe as a public route.
          res.writeHead(options.refusalStatus ?? 401, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ error: 'Authentication required', code: 'UNAUTHORIZED' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ present: durableCheck === 'present', source: 'file' }));
        return;
      }
      requests += 1;
      const body = JSON.parse(JSON.stringify(health)) as ControlledHealth;
      if (advanceFlush) {
        const persistence = body.persistence as Record<string, unknown>;
        persistence.lastPersistedAt = new Date(Date.now() + requests * 1000).toISOString();
      }
      res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
      res.end(JSON.stringify(body));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/api/health`,
        leadMarkers,
        close: () => new Promise<void>((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

describe('NOC-425 deploy storage gate', () => {
  it('accepts a deployed backend on the durable sqlite route', () => {
    const result = runGate(durableHealth());
    assert.strictEqual(result.code, 0, `the gate must accept the durable state: ${result.stderr}`);
    assert.ok(!result.stderr.includes('::error::'), 'the durable state must produce no error annotation');
  });

  it('fails when the deployed backend serves the postgres adapter', () => {
    const health = durableHealth();
    health.storageMode = 'postgres';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail on a postgres adapter');
    assert.ok(
      result.stderr.includes('serving the postgres adapter'),
      `the failure must name the serving adapter: ${result.stderr}`
    );
    assert.ok(result.stderr.includes('do not roll back'), 'the failure must name the fix-forward action');
  });

  it('fails when the backend is configured for the postgres route while sqlite serves', () => {
    const health = durableHealth();
    health.configuredStorageMode = 'postgres';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when DATABASE_URL is set');
    assert.ok(
      result.stderr.includes('DATABASE_URL must stay unset'),
      `the failure must name the setting that causes the overwrite: ${result.stderr}`
    );
  });

  it('fails when the health surface publishes no persistence bound', () => {
    const health = durableHealth();
    (health.persistence as Record<string, unknown>).persistIntervalSeconds = null;
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the bounded-flush build is not deployed');
    assert.ok(
      result.stderr.includes('does not publish a persistence bound'),
      `the failure must name the missing bound: ${result.stderr}`
    );
  });

  it('fails when the health surface publishes no successful flush timestamp', () => {
    const health = durableHealth();
    (health.persistence as Record<string, unknown>).lastPersistedAt = null;
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when no flush has ever been reported');
    assert.ok(
      result.stderr.includes('does not publish persistence.lastPersistedAt'),
      `the failure must name the missing timestamp: ${result.stderr}`
    );
  });

  it('fails when the health surface publishes no storage path facts', () => {
    const health = durableHealth();
    delete health.storagePath;
    delete health.persistentMountPath;
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the storage path facts are absent');
    assert.ok(
      result.stderr.includes('does not publish the storage path facts'),
      `the failure must name the missing facts: ${result.stderr}`
    );
  });

  it('fails when the deployed database file is not on the declared persistent mount', () => {
    const health = durableHealth();
    health.storagePath = '/opt/render/project/src/data/nightlamp.db';
    (health.persistence as Record<string, unknown>).storageOnPersistentMount = false;
    durableFileOf(health).onExpectedMountDevice = false;
    durableFileOf(health).resolvedMountPoint = '/';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail on an ephemeral database file');
    assert.ok(
      result.stderr.includes('not on the declared persistent mount'),
      `the failure must name the ephemeral state: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('/opt/render/project/src/data/nightlamp.db'),
      `the failure must name the path the operator has to move: ${result.stderr}`
    );
  });

  it('fails when the published path is not under the declared mount even though the flag says true', () => {
    const health = durableHealth();
    health.storagePath = '/mnt/data-other/nightlamp.db';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the published facts disagree');
    assert.ok(
      result.stderr.includes('published storage facts disagree'),
      `the failure must name the disagreement: ${result.stderr}`
    );
  });

  it('reports the off-mount file once when the health surface already says it is off the mount', () => {
    const health = durableHealth();
    health.storagePath = '/opt/render/project/src/data/nightlamp.db';
    (health.persistence as Record<string, unknown>).storageOnPersistentMount = false;
    durableFileOf(health).onExpectedMountDevice = false;
    durableFileOf(health).resolvedMountPoint = '/';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail on an ephemeral database file');
    assert.ok(
      !result.stderr.includes('Cannot find module'),
      `the gate script must exist for this case to measure the gate: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('not on the declared persistent mount'),
      `the failure must be the mount failure this case is about: ${result.stderr}`
    );
    assert.ok(
      !result.stderr.includes('published storage facts disagree'),
      `the facts do not disagree when the health surface says the file is off the mount: ${result.stderr}`
    );
    assert.ok(
      !result.stderr.includes('storageOnPersistentMount=true'),
      `the gate must not claim a flag value the health surface did not publish: ${result.stderr}`
    );
  });

  it('fails when the bounded flush does not advance between two samples', () => {
    const first = durableHealth();
    const second = durableHealth();
    const result = runGate(first, second);
    assert.strictEqual(result.code, 1, 'the gate must fail when the flush timestamp does not advance');
    assert.ok(
      result.stderr.includes('the bounded flush is not advancing'),
      `the failure must name the stalled flush: ${result.stderr}`
    );
  });

  it('accepts a bounded flush that advances between two samples', () => {
    const first = durableHealth();
    const second = durableHealth();
    (second.persistence as Record<string, unknown>).lastPersistedAt = '2026-11-26T12:00:02.000Z';
    const result = runGate(first, second);
    assert.strictEqual(result.code, 0, `the gate must accept an advancing flush: ${result.stderr}`);
  });

  it('reports every failed check in one run so the operator sees the whole state', () => {
    const health = durableHealth();
    health.storageMode = 'postgres';
    health.configuredStorageMode = 'postgres';
    health.storagePath = '/opt/render/project/src/data/nightlamp.db';
    (health.persistence as Record<string, unknown>).storageOnPersistentMount = false;
    durableFileOf(health).onExpectedMountDevice = false;
    durableFileOf(health).resolvedMountPoint = '/';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail on the combined misconfiguration');
    const annotations = result.stderr.split('::error::').length - 1;
    assert.ok(annotations >= 4, `every failed check must be reported, saw ${annotations}`);
  });

  it('accepts a controlled health endpoint that reports the durable state', async function () {
    this.timeout(30000);
    const health = durableHealth();
    (health.persistence as Record<string, unknown>).persistIntervalSeconds = 1;
    const server = await startHealthServer(health, true);
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 0, `the gate must accept the durable endpoint: ${result.stderr}`);
    } finally {
      await server.close();
    }
  });

  it('fails against a controlled health endpoint that reports the postgres route', async function () {
    this.timeout(30000);
    const health = durableHealth();
    health.storageMode = 'postgres';
    health.configuredStorageMode = 'postgres';
    const server = await startHealthServer(health, false);
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 1, 'the gate must fail against a postgres health endpoint');
      assert.ok(
        result.stderr.includes('serving the postgres adapter'),
        `the failure must name the serving adapter: ${result.stderr}`
      );
    } finally {
      await server.close();
    }
  });

  it('fails when the health surface does not publish the durable-file identity', () => {
    const health = durableHealth();
    delete (health.persistence as Record<string, unknown>).durableFile;
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the durable-file identity is absent');
    assert.ok(
      result.stderr.includes('does not publish the durable-file identity'),
      `the failure must name the missing identity: ${result.stderr}`
    );
  });

  it('fails when the durable-file identity could not be decided', () => {
    const health = durableHealth();
    durableFileOf(health).onExpectedMountDevice = null;
    durableFileOf(health).mountInfoReadable = false;
    durableFileOf(health).resolvedMountPoint = null;
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the device identity is undecidable');
    assert.ok(
      result.stderr.includes('could not be decided'),
      `the failure must name the undecidable state: ${result.stderr}`
    );
  });

  it('fails when the durable-file identity publishes a value that is not a verdict', () => {
    const health = durableHealth();
    durableFileOf(health).onExpectedMountDevice = 'yes';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail on a non-boolean verdict');
    assert.ok(
      result.stderr.includes('not a verdict'),
      `the failure must name the unusable verdict: ${result.stderr}`
    );
  });

  it('fails when the deployed database file is not on the declared persistent mount device', () => {
    const health = durableHealth();
    durableFileOf(health).onExpectedMountDevice = false;
    durableFileOf(health).resolvedMountPoint = '/';
    durableFileOf(health).fileDevice = '0:144';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the device says the disk is absent');
    assert.ok(
      result.stderr.includes('not on the declared persistent mount device'),
      `the failure must name the device decision: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('do not roll back'),
      `the failure must name the fix-forward action: ${result.stderr}`
    );
  });

  it('fails when the declared persistent mount path is the root filesystem', () => {
    const health = durableHealth();
    health.persistentMountPath = '';
    health.storagePath = '/nightlamp.db';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must fail when the declared mount is the root filesystem');
    assert.ok(
      result.stderr.includes('the declared persistent mount path is the root filesystem'),
      `the failure must name the root refusal: ${result.stderr}`
    );
  });

  it('fails when the declared persistent mount path is the root filesystem even though the device verdict is true', () => {
    const health = durableHealth();
    health.persistentMountPath = '/';
    health.storagePath = '/nightlamp.db';
    durableFileOf(health).onExpectedMountDevice = true;
    durableFileOf(health).resolvedMountPoint = '/';
    const result = runGate(health);
    assert.strictEqual(result.code, 1, 'the gate must refuse the root filesystem even on a true verdict');
    assert.ok(
      result.stderr.includes('the declared persistent mount path is the root filesystem'),
      `the refusal must stay in the gate: ${result.stderr}`
    );
  });

  it('states in the file mode that the write-then-read-back probe needs a live service', () => {
    const result = runGate(durableHealth());
    assert.strictEqual(result.code, 0, `the durable file-mode state must be accepted: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('runs only against a live service'),
      `the file mode must say that it cannot run the write probe: ${result.stdout}`
    );
  });

  it('writes a durability marker of the documented shape through the public lead path', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true);
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 0, `the gate must accept the durable endpoint: ${result.stderr}`);
      assert.strictEqual(server.leadMarkers.length, 1, 'the gate must write exactly one acknowledged marker');
      assert.ok(
        MARKER_PATTERN.test(server.leadMarkers[0]),
        `the marker must have the documented shape: ${server.leadMarkers[0]}`
      );
    } finally {
      await server.close();
    }
  });

  it('fails when the durable-check probe is not published', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true, { durableCheck: 'missing' });
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 1, 'the gate must fail when the product publishes no durable-check probe');
      assert.ok(
        result.stderr.includes('the durable-check probe is not published'),
        `the failure must name the missing probe: ${result.stderr}`
      );
    } finally {
      await server.close();
    }
  });

  it('fails when the durable-check probe does not answer from the file', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true, { durableCheck: 'not-file' });
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 1, 'the gate must fail when the probe answers from memory');
      assert.ok(
        result.stderr.includes('did not answer from the file'),
        `the failure must name the non-file answer: ${result.stderr}`
      );
    } finally {
      await server.close();
    }
  });

  it('fails by name when the durable-check probe cannot read the durable file', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true, { durableCheck: 'unreadable' });
    try {
      const started = Date.now();
      const result = await runGateAsync(['--url', server.url]);
      const elapsedMs = Date.now() - started;
      assert.strictEqual(result.code, 1, 'the gate must fail when the durable file cannot be read');
      assert.ok(
        result.stderr.includes('could not read the durable file'),
        `the failure must name the unreadable durable file: ${result.stderr}`
      );
      assert.ok(
        elapsedMs < 10000,
        `the gate must name the unreadable file instead of waiting out the deadline: ${elapsedMs}ms`
      );
    } finally {
      await server.close();
    }
  });

  it('fails by name when the durable-check probe is refused with 401', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true, { durableCheck: 'refused', refusalStatus: 401 });
    try {
      const started = Date.now();
      const result = await runGateAsync(['--url', server.url]);
      const elapsedMs = Date.now() - started;
      assert.strictEqual(result.code, 1, 'the gate must fail when the durable-check probe refuses an anonymous caller');
      assert.ok(
        result.stderr.includes('the durable-check probe is refused'),
        `the failure must name the refusal: ${result.stderr}`
      );
      assert.ok(
        result.stderr.includes('HTTP 401'),
        `the failure must name the status it was refused with: ${result.stderr}`
      );
      assert.ok(
        !result.stderr.includes('did not reach the durable file within'),
        `the failure must not claim the acknowledged write was lost: ${result.stderr}`
      );
      assert.ok(
        elapsedMs < 10000,
        `the gate must name the refusal instead of waiting out the deadline: ${elapsedMs}ms`
      );
    } finally {
      await server.close();
    }
  });

  it('fails by name when the durable-check probe is refused with 403', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true, { durableCheck: 'refused', refusalStatus: 403 });
    try {
      const started = Date.now();
      const result = await runGateAsync(['--url', server.url]);
      const elapsedMs = Date.now() - started;
      assert.strictEqual(result.code, 1, 'the gate must fail when the durable-check probe refuses an anonymous caller');
      assert.ok(
        result.stderr.includes('the durable-check probe is refused'),
        `the failure must name the refusal: ${result.stderr}`
      );
      assert.ok(
        result.stderr.includes('HTTP 403'),
        `the failure must name the status it was refused with: ${result.stderr}`
      );
      assert.ok(
        !result.stderr.includes('did not reach the durable file within'),
        `the failure must not claim the acknowledged write was lost: ${result.stderr}`
      );
      assert.ok(
        elapsedMs < 10000,
        `the gate must name the refusal instead of waiting out the deadline: ${elapsedMs}ms`
      );
    } finally {
      await server.close();
    }
  });

  it('fails when the acknowledged write does not reach the durable file within the deadline', async function () {
    this.timeout(120000);
    const server = await startHealthServer(durableHealth(), true, { durableCheck: 'absent' });
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 1, 'the gate must fail when the marker never reaches the file');
      assert.ok(
        result.stderr.includes('did not reach the durable file within'),
        `the failure must name the missed deadline: ${result.stderr}`
      );
    } finally {
      await server.close();
    }
  });

  it('fails when the acknowledged write is refused', async function () {
    this.timeout(30000);
    const server = await startHealthServer(durableHealth(), true, { leadWrite: 'refused' });
    try {
      const result = await runGateAsync(['--url', server.url]);
      assert.strictEqual(result.code, 1, 'the gate must fail when the durable write path refuses the marker');
      assert.ok(
        result.stderr.includes('the acknowledged write was refused'),
        `the failure must name the refused write: ${result.stderr}`
      );
    } finally {
      await server.close();
    }
  });

  it('fails when the deployed build commit does not match the expected commit', () => {
    const health = durableHealth();
    health.build = { commit: '1111111111111111111111111111111111111111', branch: 'main', source: 'render_git_commit' };
    const result = runGate(health, undefined, [
      '--expected-commit',
      '2222222222222222222222222222222222222222',
    ]);
    assert.strictEqual(result.code, 1, 'the gate must fail when the serving commit is not the pushed commit');
    assert.ok(
      result.stderr.includes('does not match the expected commit'),
      `the failure must name the commit mismatch: ${result.stderr}`
    );
  });

  it('fails when the deployed build publishes no build identity', () => {
    const health = durableHealth();
    health.build = { commit: null, branch: null, source: 'unset' };
    const result = runGate(health, undefined, [
      '--expected-commit',
      '1111111111111111111111111111111111111111',
    ]);
    assert.strictEqual(result.code, 1, 'the gate must fail when the build publishes no identity');
    assert.ok(
      result.stderr.includes('publishes no build identity'),
      `the failure must name the absent identity: ${result.stderr}`
    );
  });

  it('accepts when the deployed build commit matches the expected commit', () => {
    const health = durableHealth();
    health.build = { commit: '1111111111111111111111111111111111111111', branch: 'main', source: 'render_git_commit' };
    const result = runGate(health, undefined, [
      '--expected-commit',
      '1111111111111111111111111111111111111111',
    ]);
    assert.strictEqual(result.code, 0, `the gate must accept the matching commit: ${result.stderr}`);
  });
});
