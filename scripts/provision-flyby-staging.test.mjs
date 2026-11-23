import test from 'node:test';
import assert from 'node:assert/strict';

import {
  API_BUILD_COMMAND,
  API_PRE_DEPLOY_COMMAND,
  WEB_BUILD_COMMAND,
  buildApiEnvVars,
  buildApiServicePayload,
  buildApiServicePatch,
  buildConfig,
  buildWebEnvVars,
  buildWebServicePayload,
  buildWebServicePatch,
  findByName,
  generateVapidKeyPair,
  isValidVapidPair,
  mergeOrigins,
  pickVapid,
  planCandidates,
  serviceUrl,
  unwrapList,
  withPlanFallback,
} from './provision-flyby-staging.mjs';

test('generateVapidKeyPair emits an unpadded base64url P-256 pair', () => {
  const pair = generateVapidKeyPair();
  assert.match(pair.publicKey, /^[A-Za-z0-9_-]+$/);
  assert.match(pair.privateKey, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(pair.publicKey, 'base64url').length, 65);
  assert.equal(Buffer.from(pair.privateKey, 'base64url').length, 32);
  assert.equal(isValidVapidPair(pair.publicKey, pair.privateKey), true);
});

test('isValidVapidPair rejects malformed, padded and mismatched keys', () => {
  const pair = generateVapidKeyPair();
  assert.equal(isValidVapidPair('', pair.privateKey), false);
  assert.equal(isValidVapidPair(pair.publicKey, ''), false);
  assert.equal(isValidVapidPair(pair.publicKey, pair.publicKey), false);
  assert.equal(isValidVapidPair(Buffer.alloc(64).toString('base64url'), pair.privateKey), false);
  assert.equal(isValidVapidPair(`${pair.publicKey}=`, pair.privateKey), false);
});

test('pickVapid keeps a valid pair and replaces an invalid one', () => {
  const pair = generateVapidKeyPair();
  const kept = pickVapid(
    new Map([
      ['VAPID_PUBLIC_KEY', pair.publicKey],
      ['VAPID_PRIVATE_KEY', pair.privateKey],
    ]),
  );
  assert.equal(kept.generated, false);
  assert.equal(kept.publicKey, pair.publicKey);

  const replaced = pickVapid(new Map([['VAPID_PUBLIC_KEY', pair.publicKey]]));
  assert.equal(replaced.generated, true);
  assert.equal(isValidVapidPair(replaced.publicKey, replaced.privateKey), true);
});

test('mergeOrigins keeps existing origins and adds the staging web origin', () => {
  assert.equal(mergeOrigins('', 'https://flyby-web-staging.onrender.com'), 'https://flyby-web-staging.onrender.com');
  assert.equal(
    mergeOrigins('https://a.example, https://b.example', 'https://flyby-web-staging.onrender.com'),
    'https://a.example,https://b.example,https://flyby-web-staging.onrender.com',
  );
  assert.equal(
    mergeOrigins('https://flyby-web-staging.onrender.com', 'https://flyby-web-staging.onrender.com'),
    'https://flyby-web-staging.onrender.com',
  );
});

test('buildApiEnvVars drops MOCK_REDIS and keeps unrelated variables', () => {
  const existing = [
    { key: 'MOCK_REDIS', value: '1' },
    { key: 'CUSTOM_FLAG', value: 'keep-me' },
    { key: 'NODE_ENV', value: 'development' },
    { key: 'VAPID_PUBLIC_KEY', value: 'old-public' },
  ];
  const vapid = generateVapidKeyPair();
  const result = buildApiEnvVars(existing, {
    databaseUrl: 'postgresql://staging',
    redisUrl: 'redis://staging',
    allowedOrigins: 'https://flyby-web-staging.onrender.com',
    vapid,
    jwtSecret: 'jwt',
    adminApiKey: 'admin',
    nodeVersion: '22.22.0',
  });
  const map = new Map(result.map((item) => [item.key, item.value]));
  assert.equal(map.has('MOCK_REDIS'), false);
  assert.equal(map.get('CUSTOM_FLAG'), 'keep-me');
  assert.equal(map.get('NODE_ENV'), 'production');
  assert.equal(map.get('DATABASE_URL'), 'postgresql://staging');
  assert.equal(map.get('REDIS_URL'), 'redis://staging');
  assert.equal(map.get('VAPID_PUBLIC_KEY'), vapid.publicKey);
  assert.equal(map.get('VAPID_PRIVATE_KEY'), vapid.privateKey);
  assert.equal(map.get('VAPID_SUBJECT'), 'mailto:ops@flyby.app');
  assert.equal(map.get('JWT_SECRET'), 'jwt');
  assert.equal(map.get('ADMIN_API_KEY'), 'admin');
  assert.equal(map.get('NODE_VERSION'), '22.22.0');
  assert.equal(map.get('ALLOWED_ORIGINS'), 'https://flyby-web-staging.onrender.com');
  assert.equal(result.filter((item) => item.key === 'VAPID_PUBLIC_KEY').length, 1);
});

test('buildApiServicePayload mirrors the candidate blueprint shape', () => {
  const config = buildConfig({});
  config.ownerId = 'wrk-1';
  const payload = buildApiServicePayload(config);
  assert.equal(payload.type, 'web_service');
  assert.equal(payload.name, 'flyby-api-staging');
  assert.equal(payload.ownerId, 'wrk-1');
  assert.equal(payload.repo, 'https://github.com/samuel2064/Flyby');
  assert.equal(payload.branch, 'monorepo-candidate');
  assert.equal(payload.rootDir, 'packages/api');
  assert.equal(payload.autoDeployTrigger, 'off');
  assert.equal(payload.serviceDetails.runtime, 'node');
  assert.equal(payload.serviceDetails.plan, '0.5c-512mb');
  assert.equal(payload.serviceDetails.region, 'oregon');
  assert.equal(payload.serviceDetails.healthCheckPath, '/api/health');
  assert.equal(payload.serviceDetails.preDeployCommand, API_PRE_DEPLOY_COMMAND);
  assert.equal(payload.serviceDetails.envSpecificDetails.buildCommand, API_BUILD_COMMAND);
  assert.equal(payload.serviceDetails.envSpecificDetails.startCommand, 'node dist/server.js');
  assert.match(API_PRE_DEPLOY_COMMAND, /prisma migrate deploy/);
  assert.match(API_PRE_DEPLOY_COMMAND, /tsx prisma\/seed\.ts/);
  assert.match(API_BUILD_COMMAND, /prisma generate --schema prisma\/deploy\/schema\.postgres\.prisma/);
  assert.match(API_BUILD_COMMAND, /npx tsc/);
  assert.match(API_BUILD_COMMAND, /dist\/package\.json/);
});

test('buildApiServicePatch keeps the service configuration in sync', () => {
  const config = buildConfig({});
  config.ownerId = 'wrk-1';
  const patch = buildApiServicePatch(config);
  assert.equal(patch.branch, 'monorepo-candidate');
  assert.equal(patch.rootDir, 'packages/api');
  assert.equal(patch.serviceDetails.plan, '0.5c-512mb');
  assert.equal(patch.serviceDetails.envSpecificDetails.startCommand, 'node dist/server.js');
  assert.equal(patch.serviceDetails.region, undefined);
});

test('buildWebServicePayload mirrors the candidate static site shape', () => {
  const config = buildConfig({});
  config.ownerId = 'wrk-1';
  const payload = buildWebServicePayload(config, 'minimal');
  assert.equal(payload.type, 'static_site');
  assert.equal(payload.name, 'flyby-web-staging');
  assert.equal(payload.rootDir, 'packages/web');
  assert.equal(payload.serviceDetails.publishPath, 'dist');
  assert.equal(payload.serviceDetails.buildCommand, WEB_BUILD_COMMAND);
  assert.equal(payload.serviceDetails.routes, undefined);
  assert.equal(payload.serviceDetails.headers, undefined);
  const full = buildWebServicePayload(config, 'full');
  assert.deepEqual(full.serviceDetails.routes, [
    { type: 'rewrite', source: '/*', destination: '/index.html' },
  ]);
  assert.ok(full.serviceDetails.headers.some((header) => header.path === '/sw.js'));
  const patch = buildWebServicePatch(config);
  assert.equal(patch.serviceDetails.publishPath, 'dist');
  assert.match(WEB_BUILD_COMMAND, /npm run build/);
});

test('buildWebEnvVars points the bundle at the staging API', () => {
  const result = buildWebEnvVars([{ key: 'OTHER', value: 'value' }], 'https://flyby-api-staging.onrender.com');
  const map = new Map(result.map((item) => [item.key, item.value]));
  assert.equal(map.get('VITE_API_BASE_URL'), 'https://flyby-api-staging.onrender.com');
  assert.equal(map.get('OTHER'), 'value');
  assert.equal(map.get('NODE_VERSION'), '22.22.0');
});

test('unwrapList and findByName read the Render list envelopes', () => {
  const services = unwrapList(
    [{ service: { id: 'srv-1', name: 'flyby-api-staging' }, cursor: 'c' }],
    'service',
  );
  assert.equal(services.length, 1);
  assert.equal(findByName(services, 'flyby-api-staging').id, 'srv-1');
  assert.equal(findByName(services, 'missing'), null);
  assert.deepEqual(unwrapList({ postgres: [{ postgres: { id: 'pg-1' } }] }, 'postgres'), [{ id: 'pg-1' }]);
});

test('serviceUrl prefers the Render URL and falls back to the service name', () => {
  assert.equal(
    serviceUrl({ serviceDetails: { url: 'https://flyby-api-staging.onrender.com/' } }, 'flyby-api-staging'),
    'https://flyby-api-staging.onrender.com',
  );
  assert.equal(serviceUrl({}, 'flyby-web-staging'), 'https://flyby-web-staging.onrender.com');
});

test('buildConfig reads the staging overrides from the environment', () => {
  const config = buildConfig({
    FLYBY_REPO: 'samuel2064/Flyby',
    FLYBY_BRANCH: 'monorepo-candidate',
    FLYBY_COMMIT: 'abc123',
    STAGING_API_PLAN: 'free',
    STAGING_POSTGRES_PLAN: 'free',
    STAGING_KEY_VALUE_PLAN: 'free',
    STAGING_REGION: 'virginia',
  });
  assert.equal(config.commit, 'abc123');
  assert.equal(config.apiPlan, 'free');
  assert.equal(config.postgresPlan, 'free');
  assert.equal(config.keyValuePlan, 'free');
  assert.equal(config.region, 'virginia');
  assert.equal(config.postgresVersion, '16');
  assert.equal(config.nodeVersion, '22.22.0');
});

test('planCandidates keeps the primary plan first and drops duplicates', () => {
  assert.deepEqual(planCandidates('0.5c-512mb', ['0.5c-512mb', '1c-2g']), ['0.5c-512mb', '1c-2g']);
  assert.deepEqual(planCandidates('', ['free']), ['free']);
  assert.deepEqual(planCandidates(null, []), []);
});

test('withPlanFallback moves to the next plan when one is rejected', async () => {
  const tried = [];
  const rejected = Object.assign(new Error('Legacy Postgres plans are no longer supported'), { status: 400 });
  const result = await withPlanFallback(
    async (plan) => {
      tried.push(plan);
      if (tried.length < 2) throw rejected;
      return { id: 'pg-1' };
    },
    ['starter', '0.1c-256mb'],
    'postgres',
    () => {},
  );
  assert.deepEqual(tried, ['starter', '0.1c-256mb']);
  assert.equal(result.plan, '0.1c-256mb');
  assert.equal(result.result.id, 'pg-1');
});

test('withPlanFallback does not retry a non plan rejection', async () => {
  let attempts = 0;
  await assert.rejects(
    withPlanFallback(
      async () => {
        attempts += 1;
        throw Object.assign(new Error('insufficient token scope'), { status: 403 });
      },
      ['0.5c-512mb', '1c-2g'],
      'web service',
      () => {},
    ),
    /insufficient token scope/,
  );
  assert.equal(attempts, 1);
});

test('withPlanFallback drops to the free plan when a card is required', async () => {
  const tried = [];
  const result = await withPlanFallback(
    async (plan) => {
      tried.push(plan);
      if (plan !== 'free') {
        throw Object.assign(new Error('Payment information is required'), { status: 402 });
      }
      return { id: 'srv-1' };
    },
    ['0.5c-512mb', '1c-2g', 'free'],
    'web service',
    () => {},
  );
  assert.deepEqual(tried, ['0.5c-512mb', 'free']);
  assert.equal(result.plan, 'free');
});
