import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from './provision-flyby-staging.mjs';

function startMockRender() {
  const state = {
    postgres: null,
    keyValue: null,
    services: new Map(),
    envVars: new Map(),
    routes: new Map(),
    headers: new Map(),
    deploys: [],
    requests: [],
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(request.url, `http://${request.headers.host}`);
      const path = url.pathname;
      state.requests.push({ method: request.method, path, body });

      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      if (path === '/v1/owners') {
        send(200, [{ owner: { id: 'wrk-1', name: 'Flyby', type: 'team' } }]);
        return;
      }
      if (path === '/v1/services' && request.method === 'GET') {
        send(200, [...state.services.values()].map((service) => ({ service })));
        return;
      }
      if (path === '/v1/services' && request.method === 'POST') {
        const id = `srv-${state.services.size + 1}`;
        const service = {
          id,
          name: body.name,
          type: body.type,
          ownerId: body.ownerId,
          repo: body.repo,
          branch: body.branch,
          rootDir: body.rootDir,
          autoDeployTrigger: body.autoDeployTrigger,
          serviceDetails: {
            ...(body.serviceDetails || {}),
            url: `http://127.0.0.1:${server.address().port}`,
            plan: body.serviceDetails?.plan,
          },
        };
        state.services.set(id, service);
        send(201, { service, deployId: `dep-${id}` });
        return;
      }
      const serviceMatch = path.match(/^\/v1\/services\/([^/]+)(\/[a-z-]+)?$/);
      if (serviceMatch) {
        const [, serviceId, suffix] = serviceMatch;
        const service = state.services.get(serviceId);
        if (!service) {
          send(404, { message: 'service not found' });
          return;
        }
        if (suffix === '/env-vars' && request.method === 'GET') {
          send(200, (state.envVars.get(serviceId) || []).map((value) => ({ envVar: value })));
          return;
        }
        if (suffix === '/env-vars' && request.method === 'PUT') {
          state.envVars.set(serviceId, body);
          send(200, body.map((value) => ({ envVar: value })));
          return;
        }
        if (suffix === '/routes' && request.method === 'PUT') {
          state.routes.set(serviceId, body);
          send(200, body.map((route, index) => ({ id: `route-${index}`, priority: index, ...route })));
          return;
        }
        if (suffix === '/headers' && request.method === 'PUT') {
          state.headers.set(serviceId, body);
          send(200, body.map((header, index) => ({ id: `header-${index}`, ...header })));
          return;
        }
        if (suffix === '/deploys' && request.method === 'POST') {
          state.deploys.push({ serviceId, body });
          send(201, { deploy: { id: `dep-${serviceId}-${state.deploys.length}`, status: 'created' } });
          return;
        }
        if (suffix === '/deploys' && request.method === 'GET') {
          send(200, [
            { deploy: { id: `dep-${serviceId}-${state.deploys.length}`, status: 'live' } },
          ]);
          return;
        }
        if (!suffix && request.method === 'PATCH') {
          Object.assign(service, {
            repo: body.repo ?? service.repo,
            branch: body.branch ?? service.branch,
            rootDir: body.rootDir ?? service.rootDir,
            autoDeployTrigger: body.autoDeployTrigger ?? service.autoDeployTrigger,
          });
          service.serviceDetails = { ...service.serviceDetails, ...(body.serviceDetails || {}) };
          send(200, service);
          return;
        }
      }
      if (path === '/v1/postgres' && request.method === 'GET') {
        send(200, state.postgres ? [{ postgres: state.postgres }] : []);
        return;
      }
      if (path === '/v1/postgres' && request.method === 'POST') {
        state.postgres = { id: 'pg-1', name: body.name, plan: body.plan, region: body.region };
        send(201, state.postgres);
        return;
      }
      if (path === '/v1/postgres/pg-1/connection-info') {
        send(200, { internalConnectionString: 'postgresql://staging:secret@pg.internal/flyby' });
        return;
      }
      if (path === '/v1/key-value' && request.method === 'GET') {
        send(200, state.keyValue ? [{ keyValue: state.keyValue }] : []);
        return;
      }
      if (path === '/v1/key-value' && request.method === 'POST') {
        state.keyValue = { id: 'red-1', name: body.name, plan: body.plan, region: body.region };
        send(201, state.keyValue);
        return;
      }
      if (path === '/v1/key-value/red-1/connection-info') {
        send(200, { internalConnectionString: 'redis://kv.internal:6379' });
        return;
      }
      if (path === '/api/health') {
        send(200, { status: 'ok', environment: 'production', services: { database: 'ok', redis: 'ok' } });
        return;
      }
      if (path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end('<html><body><div id="root"></div></body></html>');
        return;
      }
      send(404, { message: `unhandled ${request.method} ${path}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, port: server.address().port });
    });
  });
}

test('main provisions the staging pair against the Render API', async (t) => {
  const { server, state, port } = await startMockRender();
  t.after(() => server.close());

  const reportDir = mkdtempSync(join(tmpdir(), 'flyby-staging-'));
  const reportPath = join(reportDir, 'report.json');
  const previousEnv = { ...process.env };
  const originalLog = console.log;
  console.log = () => {};
  process.env.RENDER_API_KEY = 'test-key';
  process.env.RENDER_API_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.RENDER_OWNER_ID = '';
  process.env.STAGING_REPORT_PATH = reportPath;
  process.env.FLYBY_COMMIT = '';
  t.after(() => {
    console.log = originalLog;
    for (const key of Object.keys(process.env)) {
      if (!(key in previousEnv)) delete process.env[key];
    }
    Object.assign(process.env, previousEnv);
  });

  await main([]);

  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.equal(report.postgresId, 'pg-1');
  assert.equal(report.keyValueId, 'red-1');
  assert.equal(report.failures.length, 0);
  assert.equal(report.plans.postgres, '0.1c-256mb');
  assert.equal(report.apiServiceId, 'srv-1');
  assert.equal(report.webServiceId, 'srv-2');
  assert.equal(report.apiDeploy.status, 'live');
  assert.equal(report.webDeploy.status, 'live');
  assert.equal(report.health.status, 'ok');

  const apiEnv = new Map(state.envVars.get('srv-1').map((item) => [item.key, item.value]));
  assert.equal(apiEnv.get('DATABASE_URL'), 'postgresql://staging:secret@pg.internal/flyby');
  assert.equal(apiEnv.get('REDIS_URL'), 'redis://kv.internal:6379');
  assert.equal(apiEnv.get('NODE_ENV'), 'production');
  assert.equal(apiEnv.has('MOCK_REDIS'), false);
  assert.equal(Buffer.from(apiEnv.get('VAPID_PUBLIC_KEY'), 'base64url').length, 65);
  assert.equal(Buffer.from(apiEnv.get('VAPID_PRIVATE_KEY'), 'base64url').length, 32);
  assert.ok(apiEnv.get('ADMIN_API_KEY'));
  assert.ok(apiEnv.get('JWT_SECRET'));

  const webEnv = new Map(state.envVars.get('srv-2').map((item) => [item.key, item.value]));
  assert.equal(webEnv.get('VITE_API_BASE_URL'), `http://127.0.0.1:${port}`);

  assert.deepEqual(state.routes.get('srv-2'), [
    { type: 'rewrite', source: '/*', destination: '/index.html' },
  ]);
  assert.ok(state.headers.get('srv-2').some((header) => header.path === '/sw.js'));
  assert.equal(state.deploys.length, 2);
});
