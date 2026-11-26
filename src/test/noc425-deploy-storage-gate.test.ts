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

function durableHealth(): ControlledHealth {
  return {
    status: 'ok',
    storageMode: 'sqlite',
    configuredStorageMode: 'sqlite',
    storagePath: '/mnt/data/nightlamp.db',
    persistentMountPath: '/mnt/data',
    persistence: {
      persistIntervalSeconds: 2,
      lastPersistedAt: '2026-11-26T12:00:00.000Z',
      storageOnPersistentMount: true,
    },
  };
}

function runGate(first: ControlledHealth, second?: ControlledHealth): GateResult {
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
    const result = spawnSync(process.execPath, [GATE_SCRIPT, ...files], { encoding: 'utf8' });
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

function startHealthServer(health: ControlledHealth, advanceFlush: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let requests = 0;
    const sockets = new Set<import('net').Socket>();
    const server = http.createServer((_req, res) => {
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
});
