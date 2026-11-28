import assert from 'assert';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'render-deploy.mjs');
const WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'deploy.yml');

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_COMMIT = 'f0e9d8c7b6a5948372615f4e3d2c1b0a99887766';
const SERVICE_ID = 'srv-noc434';
const DEPLOY_ID = 'dep-noc4340001';
// The key is assembled from parts so that no literal in this file reads like a
// credential to a secret scanner.
const FAKE_KEY = ['test', 'noc434', 'not-a-real-key'].join('-');

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface StubOptions {
  triggerStatus?: number;
  triggerBody?: string;
  pollStatuses?: string[];
}

interface StubRequest {
  method: string;
  pathname: string;
  body: string;
  authorization: string | undefined;
}

interface Stub {
  baseUrl: string;
  requests: StubRequest[];
  close: () => Promise<void>;
}

function deployBody(options: {
  deployId?: string | null;
  commit?: string | null;
  commitAsString?: boolean;
  status?: string;
}): string {
  const deploy: Record<string, unknown> = { status: options.status ?? 'created' };
  if (options.deployId !== null) deploy.id = options.deployId ?? DEPLOY_ID;
  if (options.commit !== null && options.commit !== undefined) {
    deploy.commit = options.commitAsString ? options.commit : { id: options.commit };
  }
  return JSON.stringify(deploy);
}

function startStub(options: StubOptions = {}): Promise<Stub> {
  const requests: StubRequest[] = [];
  const pollStatuses = options.pollStatuses ?? ['live'];
  let pollIndex = 0;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
        requests.push({
          method: req.method ?? '',
          pathname: requestUrl.pathname,
          body,
          authorization: req.headers.authorization,
        });
        if (req.method === 'POST' && requestUrl.pathname === `/v1/services/${SERVICE_ID}/deploys`) {
          const status = options.triggerStatus ?? 201;
          const payload = options.triggerBody ?? deployBody({ commit: COMMIT });
          res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(payload);
          return;
        }
        if (req.method === 'GET' && requestUrl.pathname.startsWith(`/v1/services/${SERVICE_ID}/deploys/`)) {
          const status = pollStatuses[Math.min(pollIndex, pollStatuses.length - 1)];
          pollIndex += 1;
          res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify({ id: DEPLOY_ID, commit: { id: COMMIT }, status }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        // The script's fetches keep their sockets alive, so the stub has to
        // drop them before close() can finish.
        close: () => new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

// The stub server lives in this process, so the script has to be spawned
// asynchronously: a synchronous spawn would block the event loop that has to
// answer the script's requests.
function runScript(args: string[], options: { apiKey?: string | null; githubOutput?: string } = {}): Promise<ScriptResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.apiKey === null) {
    delete env.RENDER_API_KEY;
  } else {
    env.RENDER_API_KEY = options.apiKey ?? FAKE_KEY;
  }
  if (options.githubOutput) {
    env.GITHUB_OUTPUT = options.githubOutput;
  } else {
    delete env.GITHUB_OUTPUT;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function countLines(stdout: string, key: string): number {
  return stdout.split('\n').filter((line) => line.startsWith(`${key}=`)).length;
}

function factValue(stdout: string, key: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
  return null;
}

function extractJob(yaml: string, jobName: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.ok(start >= 0, `the workflow has no ${jobName} job`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^( {0,1}\S| {2}\S)/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join('\n');
}

describe('NOC-434 the Render deploy trigger pins the commit and waits for the deploy to go live', () => {
  it('creates the deploy for the pinned commit and waits until it is live', async () => {
    const stub = await startStub({ pollStatuses: ['build_in_progress', 'live'] });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
      assert.strictEqual(countLines(result.stdout, 'DEPLOY_ID'), 1);
      assert.strictEqual(countLines(result.stdout, 'DEPLOY_COMMIT'), 1);
      assert.strictEqual(countLines(result.stdout, 'DEPLOY_STATUS'), 1);
      assert.strictEqual(factValue(result.stdout, 'DEPLOY_ID'), DEPLOY_ID);
      assert.strictEqual(factValue(result.stdout, 'DEPLOY_COMMIT'), COMMIT);
      assert.strictEqual(factValue(result.stdout, 'DEPLOY_STATUS'), 'live');

      const post = stub.requests.find((request) => request.method === 'POST');
      assert.ok(post, 'the script did not trigger a deploy');
      assert.strictEqual(post.pathname, `/v1/services/${SERVICE_ID}/deploys`);
      assert.deepStrictEqual(JSON.parse(post.body), { commitId: COMMIT });
      assert.strictEqual(post.authorization, `Bearer ${FAKE_KEY}`);

      const polls = stub.requests.filter((request) => request.method === 'GET');
      assert.ok(polls.length >= 1, 'the script did not poll the deploy');
      assert.strictEqual(polls[0].pathname, `/v1/services/${SERVICE_ID}/deploys/${DEPLOY_ID}`);
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy is for a different commit than the one pushed', async () => {
    const stub = await startStub({ triggerBody: deployBody({ commit: OTHER_COMMIT }) });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('different commit than the one pushed'),
        `expected a named pin failure, got: ${result.stderr}`
      );
      assert.ok(result.stderr.includes(OTHER_COMMIT), 'the failure does not name the deployed commit');
      assert.ok(result.stderr.includes(COMMIT), 'the failure does not name the pushed commit');
      assert.strictEqual(countLines(result.stdout, 'DEPLOY_COMMIT'), 1);
      assert.strictEqual(factValue(result.stdout, 'DEPLOY_COMMIT'), OTHER_COMMIT);
    } finally {
      await stub.close();
    }
  });

  it('accepts a shortened commit identity that is the pushed commit', async () => {
    const stub = await startStub({ triggerBody: deployBody({ commit: COMMIT.slice(0, 7) }) });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
      assert.strictEqual(factValue(result.stdout, 'DEPLOY_COMMIT'), COMMIT.slice(0, 7));
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy response publishes no commit identity', async () => {
    const stub = await startStub({ triggerBody: deployBody({ commit: null }) });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('does not publish the commit identity'),
        `expected a named shape failure, got: ${result.stderr}`
      );
      assert.ok(result.stderr.includes('the API shape changed'), 'the failure does not name the shape change');
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy response publishes no deploy id', async () => {
    const stub = await startStub({ triggerBody: deployBody({ deployId: null, commit: COMMIT }) });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('does not publish a deploy id'),
        `expected a named shape failure, got: ${result.stderr}`
      );
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy reaches a terminal failure', async () => {
    const stub = await startStub({ pollStatuses: ['build_failed'] });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('terminal failure'),
        `expected a named terminal failure, got: ${result.stderr}`
      );
      assert.ok(result.stderr.includes('build_failed'), 'the failure does not name the status');
      assert.ok(result.stderr.includes(DEPLOY_ID), 'the failure does not name the deploy id');
      assert.strictEqual(factValue(result.stdout, 'DEPLOY_STATUS'), 'build_failed');
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy does not go live within the budget', async () => {
    const stub = await startStub({ pollStatuses: ['build_in_progress'] });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--timeout-sec', '1',
        '--poll-sec', '1',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('did not go live within'),
        `expected a named timeout failure, got: ${result.stderr}`
      );
      assert.ok(result.stderr.includes('build_in_progress'), 'the timeout does not name the last status');
      assert.ok(result.stderr.includes(DEPLOY_ID), 'the timeout does not name the deploy id');
      assert.ok(result.stderr.includes('within 1s'), 'the timeout does not name the elapsed budget');
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy trigger is refused', async () => {
    const stub = await startStub({ triggerStatus: 500, triggerBody: JSON.stringify({ message: 'service not found' }) });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('trigger was refused (HTTP 500)'),
        `expected a named trigger failure, got: ${result.stderr}`
      );
      assert.strictEqual(countLines(result.stdout, 'DEPLOY_ID'), 0);
    } finally {
      await stub.close();
    }
  });

  it('fails by name when the deploy response is not JSON', async () => {
    const stub = await startStub({ triggerBody: 'not json at all' });
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(result.code, 1);
      assert.ok(
        result.stderr.includes('the Render deploy response is not JSON'),
        `expected a named malformed-body failure, got: ${result.stderr}`
      );
    } finally {
      await stub.close();
    }
  });

  it('never prints the API key, not on success and not on failure', async () => {
    const successStub = await startStub({});
    try {
      const ok = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', successStub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(ok.code, 0);
      assert.ok(!ok.stdout.includes(FAKE_KEY), 'the API key reached stdout');
      assert.ok(!ok.stderr.includes(FAKE_KEY), 'the API key reached stderr');
    } finally {
      await successStub.close();
    }

    const failureStub = await startStub({ triggerStatus: 401, triggerBody: JSON.stringify({ message: 'invalid key' }) });
    try {
      const failed = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', failureStub.baseUrl,
        '--poll-sec', '0',
      ]);
      assert.strictEqual(failed.code, 1);
      assert.ok(!failed.stdout.includes(FAKE_KEY), 'the API key reached stdout');
      assert.ok(!failed.stderr.includes(FAKE_KEY), 'the API key reached stderr');
    } finally {
      await failureStub.close();
    }
  });

  it('refuses to run without the API key in the environment', async () => {
    const result = await runScript(['--service-id', SERVICE_ID, '--commit', COMMIT], { apiKey: null });
    assert.strictEqual(result.code, 2);
    assert.ok(
      result.stderr.includes('RENDER_API_KEY is not set'),
      `expected the missing-key failure, got: ${result.stderr}`
    );
  });

  it('writes the proved deploy facts to the GitHub step output', async () => {
    const stub = await startStub({});
    const outputPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'noc434-output-')), 'github-output');
    try {
      const result = await runScript([
        '--service-id', SERVICE_ID,
        '--commit', COMMIT,
        '--api-base', stub.baseUrl,
        '--poll-sec', '0',
      ], { githubOutput: outputPath });
      assert.strictEqual(result.code, 0, `expected exit 0, got ${result.code}: ${result.stderr}`);
      const written = fs.readFileSync(outputPath, 'utf8');
      assert.ok(written.includes(`deploy_id=${DEPLOY_ID}`), `the step output has no deploy id: ${written}`);
      assert.ok(written.includes(`deploy_commit=${COMMIT}`), `the step output has no deploy commit: ${written}`);
      assert.ok(written.includes('deploy_status=live'), `the step output has no deploy status: ${written}`);
    } finally {
      await stub.close();
      fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
    }
  });
});

describe('NOC-434 the deploy workflow waits for the deploy before the storage gate runs', () => {
  const yaml = fs.readFileSync(WORKFLOW, 'utf8');

  it('triggers the deploy with the script instead of an unpinned POST', () => {
    const job = extractJob(yaml, 'deploy-backend');
    assert.ok(job.includes('node scripts/render-deploy.mjs'), 'the deploy job does not run the render-deploy script');
    assert.ok(job.includes('--commit'), 'the deploy job does not pass the commit to the script');
    assert.ok(job.includes('GITHUB_SHA'), 'the deploy job does not pin the pushed commit');
    assert.ok(!job.includes("-d '{}'"), 'the deploy job still fires an unpinned deploy');
    assert.ok(job.includes('timeout-minutes'), 'the deploy job has no budget for the wait');
  });

  it('has no blind sleep in the smoke job', () => {
    const job = extractJob(yaml, 'smoke');
    // The blind wait was a step whose body is `run: sleep 60`, so the
    // assertion looks for the sleep itself and not for a line that starts with
    // it. A line-anchored pattern would pass on a workflow that still sleeps.
    assert.ok(
      !job.includes('sleep 60'),
      'the smoke job still sleeps blind before the gate runs'
    );
    assert.ok(
      !job.includes('Wait for deployment to stabilize'),
      'the smoke job still waits blind for the deployment to stabilize'
    );
  });

  it('keeps the storage gate in the smoke job after the deploy job', () => {
    const job = extractJob(yaml, 'smoke');
    assert.ok(job.includes('node scripts/deploy-storage-gate.mjs --url'), 'the smoke job lost the storage gate');
    const needsLine = job.split('\n').find((line) => line.trim().startsWith('needs:'));
    assert.ok(needsLine, 'the smoke job has no needs');
    assert.ok(needsLine.includes('deploy-backend'), 'the smoke job no longer needs the deploy job');
  });

  it('leaves the frontend deploy job alone', () => {
    const job = extractJob(yaml, 'deploy-frontend');
    assert.ok(job.includes("-d '{}'"), 'the frontend deploy job was changed by this scope');
  });

  it('names the proved deploy id in the failure alert', () => {
    const job = extractJob(yaml, 'alert-on-failure');
    assert.ok(
      job.includes("needs['deploy-backend'].outputs.deploy_id"),
      'the alert job does not read the proved deploy id from the deploy job'
    );
    const deployJob = extractJob(yaml, 'deploy-backend');
    assert.ok(
      deployJob.includes('deploy_id: ${{ steps.render_deploy.outputs.deploy_id }}'),
      'the deploy job does not publish the proved deploy id as an output'
    );
  });
});
