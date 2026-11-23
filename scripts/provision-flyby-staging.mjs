#!/usr/bin/env node
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function apiBase() {
  return process.env.RENDER_API_BASE_URL || 'https://api.render.com/v1';
}
const PROD_SERVICE_IDS = new Set(['srv-dak58lm1egvs73957l50', 'srv-dapocsugekts73ek60t0']);
const FAILED_DEPLOY_STATUSES = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'deactivated', 'canceled']);

export const API_BUILD_COMMAND =
  'if [ -f packages/api/package.json ]; then cd packages/api; fi && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --include=dev && npx prisma generate --schema prisma/deploy/schema.postgres.prisma && npx tsc && node -e "require(\'fs\').writeFileSync(\'dist/package.json\', JSON.stringify({type:\'commonjs\'}))"';

export const API_PRE_DEPLOY_COMMAND =
  'npx prisma migrate deploy --schema prisma/deploy/schema.postgres.prisma && npx tsx prisma/seed.ts';

export const WEB_BUILD_COMMAND =
  'if [ -f packages/web/package.json ]; then cd packages/web; fi && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --include=dev && npm run build';

export const WEB_ROUTES = [{ type: 'rewrite', source: '/*', destination: '/index.html' }];

export const WEB_HEADERS = [
  { path: '/assets/*', name: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
  { path: '/sw.js', name: 'Cache-Control', value: 'no-cache' },
  { path: '/index.html', name: 'Cache-Control', value: 'no-cache' },
];

export const API_PLAN_FALLBACKS = ['0.5c-512mb', '1c-2g', 'free'];
export const POSTGRES_PLAN_FALLBACKS = ['0.1c-256mb', '0.5c-1g', '1c-2g', 'free'];
export const KEY_VALUE_PLAN_FALLBACKS = ['free', '256mb', '1g'];

export function buildConfig(env = process.env) {
  return {
    repo: env.FLYBY_REPO || 'samuel2064/Flyby',
    branch: env.FLYBY_BRANCH || 'monorepo-candidate',
    commit: env.FLYBY_COMMIT || '',
    ownerId: env.RENDER_OWNER_ID || '',
    region: env.STAGING_REGION || 'oregon',
    apiPlan: env.STAGING_API_PLAN || '0.5c-512mb',
    postgresPlan: env.STAGING_POSTGRES_PLAN || '0.1c-256mb',
    keyValuePlan: env.STAGING_KEY_VALUE_PLAN || 'free',
    postgresVersion: env.STAGING_POSTGRES_VERSION || '16',
    nodeVersion: env.STAGING_NODE_VERSION || '22.22.0',
    apiServiceName: env.STAGING_API_SERVICE_NAME || 'flyby-api-staging',
    webServiceName: env.STAGING_WEB_SERVICE_NAME || 'flyby-web-staging',
    postgresName: env.STAGING_POSTGRES_NAME || 'flyby-staging-pg',
    keyValueName: env.STAGING_KEY_VALUE_NAME || 'flyby-staging-kv',
    reportPath: env.STAGING_REPORT_PATH || 'staging-provision.json',
  };
}

export function planCandidates(primary, fallbacks) {
  const candidates = [];
  for (const plan of [primary, ...(fallbacks || [])]) {
    const trimmed = String(plan || '').trim();
    if (trimmed && !candidates.includes(trimmed)) candidates.push(trimmed);
  }
  return candidates;
}

export async function withPlanFallback(operation, candidates, label, log) {
  let lastError = null;
  let paymentRequired = false;
  for (const plan of candidates) {
    if (paymentRequired && plan !== 'free') continue;
    try {
      const result = await operation(plan);
      if (candidates.indexOf(plan) > 0) log(`${label} plan ${plan} is in use`);
      return { result, plan };
    } catch (error) {
      lastError = error;
      if (error.status === 402) {
        paymentRequired = true;
        log(`${label} plan ${plan} needs a payment method: ${error.message}`);
        continue;
      }
      if (![400, 422].includes(error.status)) throw error;
      log(`${label} plan ${plan} was rejected: ${error.message}`);
    }
  }
  throw lastError;
}

export function unwrapList(payload, key) {
  const items = Array.isArray(payload) ? payload : (payload?.[key] ?? []);
  return items
    .map((item) => (item && typeof item === 'object' && item[key] && typeof item[key] === 'object' ? item[key] : item))
    .filter((item) => item && typeof item === 'object');
}

export function findByName(items, name) {
  return items.find((item) => item.name === name) ?? null;
}

export function generateVapidKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const publicRaw = spki.subarray(spki.length - 65);
  const privateRaw = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  return {
    publicKey: publicRaw.toString('base64url'),
    privateKey: privateRaw.toString('base64url'),
  };
}

export function isValidVapidPair(publicKey, privateKey) {
  if (typeof publicKey !== 'string' || typeof privateKey !== 'string') return false;
  const publicValue = publicKey.trim();
  const privateValue = privateKey.trim();
  if (!/^[A-Za-z0-9_-]+$/.test(publicValue) || !/^[A-Za-z0-9_-]+$/.test(privateValue)) return false;
  return Buffer.from(publicValue, 'base64url').length === 65 && Buffer.from(privateValue, 'base64url').length === 32;
}

export function pickVapid(existingMap) {
  const publicKey = (existingMap.get('VAPID_PUBLIC_KEY') || '').trim();
  const privateKey = (existingMap.get('VAPID_PRIVATE_KEY') || '').trim();
  if (isValidVapidPair(publicKey, privateKey)) return { publicKey, privateKey, generated: false };
  return { ...generateVapidKeyPair(), generated: true };
}

export function mergeOrigins(existing, webUrl) {
  const values = new Set();
  for (const entry of String(existing || '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed) values.add(trimmed);
  }
  if (webUrl) values.add(webUrl);
  return [...values].join(',');
}

export function buildApiEnvVars(existing, values) {
  const managed = new Map([
    ['DATABASE_URL', values.databaseUrl],
    ['REDIS_URL', values.redisUrl],
    ['NODE_ENV', 'production'],
    ['ALLOWED_ORIGINS', values.allowedOrigins],
    ['VAPID_PUBLIC_KEY', values.vapid.publicKey],
    ['VAPID_PRIVATE_KEY', values.vapid.privateKey],
    ['VAPID_SUBJECT', values.vapidSubject || 'mailto:ops@flyby.app'],
    ['JWT_SECRET', values.jwtSecret],
    ['ADMIN_API_KEY', values.adminApiKey],
    ['NODE_VERSION', values.nodeVersion],
  ]);
  const result = [];
  const seen = new Set();
  for (const item of existing) {
    const key = item.key;
    if (typeof key !== 'string' || seen.has(key)) continue;
    if (key === 'MOCK_REDIS') continue;
    seen.add(key);
    result.push({ key, value: managed.has(key) ? managed.get(key) : item.value });
  }
  for (const [key, value] of managed) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ key, value });
  }
  return result;
}

export function buildWebEnvVars(existing, apiUrl) {
  const result = [];
  const seen = new Set();
  for (const item of existing) {
    if (typeof item.key !== 'string' || seen.has(item.key)) continue;
    seen.add(item.key);
    result.push({ key: item.key, value: item.key === 'VITE_API_BASE_URL' ? apiUrl : item.value });
  }
  if (!seen.has('VITE_API_BASE_URL')) result.push({ key: 'VITE_API_BASE_URL', value: apiUrl });
  if (!seen.has('NODE_VERSION')) result.push({ key: 'NODE_VERSION', value: '22.22.0' });
  return result;
}

export function buildApiServicePayload(config, plan = config.apiPlan) {
  return {
    type: 'web_service',
    name: config.apiServiceName,
    ownerId: config.ownerId,
    repo: `https://github.com/${config.repo}`,
    branch: config.branch,
    rootDir: 'packages/api',
    autoDeployTrigger: 'off',
    serviceDetails: {
      runtime: 'node',
      plan,
      region: config.region,
      healthCheckPath: '/api/health',
      preDeployCommand: API_PRE_DEPLOY_COMMAND,
      envSpecificDetails: {
        buildCommand: API_BUILD_COMMAND,
        startCommand: 'node dist/server.js',
      },
    },
  };
}

export function buildApiServicePatch(config, plan = config.apiPlan) {
  return {
    repo: `https://github.com/${config.repo}`,
    branch: config.branch,
    rootDir: 'packages/api',
    autoDeployTrigger: 'off',
    serviceDetails: {
      runtime: 'node',
      plan,
      healthCheckPath: '/api/health',
      preDeployCommand: API_PRE_DEPLOY_COMMAND,
      envSpecificDetails: {
        buildCommand: API_BUILD_COMMAND,
        startCommand: 'node dist/server.js',
      },
    },
  };
}

export function buildWebServicePayload(config, variant = 'minimal') {
  const payload = {
    type: 'static_site',
    name: config.webServiceName,
    ownerId: config.ownerId,
    repo: `https://github.com/${config.repo}`,
    branch: config.branch,
    rootDir: 'packages/web',
    autoDeployTrigger: 'off',
    serviceDetails: {
      buildCommand: WEB_BUILD_COMMAND,
      publishPath: 'dist',
    },
  };
  if (variant === 'previews') payload.serviceDetails.pullRequestPreviewsEnabled = false;
  if (variant === 'full') {
    payload.serviceDetails.pullRequestPreviewsEnabled = false;
    payload.serviceDetails.routes = WEB_ROUTES;
    payload.serviceDetails.headers = WEB_HEADERS;
  }
  return payload;
}

export function buildWebServicePatch(config) {
  return {
    repo: `https://github.com/${config.repo}`,
    branch: config.branch,
    rootDir: 'packages/web',
    autoDeployTrigger: 'off',
    serviceDetails: {
      buildCommand: WEB_BUILD_COMMAND,
      publishPath: 'dist',
      pullRequestPreviewsEnabled: false,
    },
  };
}

export function serviceUrl(service, fallbackName) {
  const detailsUrl = service?.serviceDetails?.url;
  if (typeof detailsUrl === 'string' && detailsUrl) return detailsUrl.replace(/\/+$/, '');
  return `https://${String(fallbackName).toLowerCase()}.onrender.com`;
}

export class RenderClient {
  constructor(apiKey, { dryRun = false } = {}) {
    this.apiKey = apiKey;
    this.dryRun = dryRun;
  }

  async request(method, path, body, options = {}) {
    const response = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text.slice(0, 200) };
      }
    }
    if (!response.ok) {
      const detail = options.sensitive
        ? ''
        : ` ${payload?.code ?? ''} ${payload?.message ?? ''}`.trim();
      const error = new Error(`${method} ${path} failed: HTTP ${response.status}${detail}`);
      error.status = response.status;
      error.code = payload?.code;
      throw error;
    }
    return payload;
  }

  get(path, options) {
    return this.request('GET', path, undefined, options);
  }

  post(path, body, options) {
    return this.request('POST', path, body, options);
  }

  patch(path, body, options) {
    return this.request('PATCH', path, body, options);
  }

  put(path, body, options) {
    return this.request('PUT', path, body, options);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveOwnerId(client, config, log) {
  if (config.ownerId) {
    log(`using workspace ${config.ownerId}`);
    return config.ownerId;
  }
  const services = unwrapList(await client.get('/services?limit=100'), 'service');
  const prodService = services.find((service) => PROD_SERVICE_IDS.has(service.id));
  if (prodService?.ownerId) {
    log(`workspace resolved from the production service: ${prodService.ownerId}`);
    return prodService.ownerId;
  }
  const owners = unwrapList(await client.get('/owners?limit=100'), 'owner');
  if (owners.length === 1) return owners[0].id;
  if (owners.length > 1) {
    const owner = owners.find((item) => item.type === 'team') ?? owners[0];
    return owner.id;
  }
  throw new Error('could not resolve the Render workspace id');
}

async function waitForConnectionInfo(client, path, label, id, log, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const info = await client.get(path);
      if (info?.internalConnectionString) return info;
      lastError = 'connection info is not populated yet';
    } catch (error) {
      lastError = error.message;
      if (error.status && ![400, 404, 409, 429, 500, 503].includes(error.status)) throw error;
    }
    log(`waiting for ${label} ${id} to become ready`);
    await sleep(15000);
  }
  throw new Error(`${label} ${id} did not become ready: ${lastError}`);
}

async function ensurePostgres(client, config, log, dryRun) {
  const instances = unwrapList(await client.get(`/postgres?ownerId=${config.ownerId}&limit=100`), 'postgres');
  let instance = findByName(instances, config.postgresName);
  let plan = instance?.plan || config.postgresPlan;
  if (!instance) {
    if (dryRun) {
      log(`dry-run: would create postgres ${config.postgresName} (${config.postgresPlan})`);
      return null;
    }
    const created = await withPlanFallback(
      (candidate) =>
        client.post('/postgres', {
          name: config.postgresName,
          plan: candidate,
          ownerId: config.ownerId,
          region: config.region,
          version: config.postgresVersion,
          databaseName: 'flyby_staging',
        }),
      planCandidates(config.postgresPlan, POSTGRES_PLAN_FALLBACKS),
      'postgres',
      log,
    );
    instance = created.result;
    plan = created.plan;
    log(`created postgres ${config.postgresName} (${instance.id}) on plan ${plan}`);
    if (plan === 'free') log('warning: the staging Postgres is on the free plan and expires after 30 days');
  } else {
    log(`reusing postgres ${config.postgresName} (${instance.id}) on plan ${instance.plan}`);
  }
  const info = await waitForConnectionInfo(
    client,
    `/postgres/${instance.id}/connection-info`,
    'postgres',
    instance.id,
    log,
  );
  return { id: instance.id, plan, internalConnectionString: info.internalConnectionString };
}

async function ensureKeyValue(client, config, log, dryRun) {
  const instances = unwrapList(await client.get(`/key-value?ownerId=${config.ownerId}&limit=100`), 'keyValue');
  let instance = findByName(instances, config.keyValueName);
  let plan = instance?.plan || config.keyValuePlan;
  if (!instance) {
    if (dryRun) {
      log(`dry-run: would create key value ${config.keyValueName} (${config.keyValuePlan})`);
      return null;
    }
    const created = await withPlanFallback(
      (candidate) =>
        client.post('/key-value', {
          name: config.keyValueName,
          plan: candidate,
          ownerId: config.ownerId,
          region: config.region,
        }),
      planCandidates(config.keyValuePlan, KEY_VALUE_PLAN_FALLBACKS),
      'key value',
      log,
    );
    instance = created.result;
    plan = created.plan;
    log(`created key value ${config.keyValueName} (${instance.id}) on plan ${plan}`);
  } else {
    log(`reusing key value ${config.keyValueName} (${instance.id}) on plan ${instance.plan}`);
  }
  const info = await waitForConnectionInfo(
    client,
    `/key-value/${instance.id}/connection-info`,
    'key value',
    instance.id,
    log,
  );
  return { id: instance.id, plan, internalConnectionString: info.internalConnectionString };
}

async function ensureService(client, config, log, dryRun, spec) {
  const services = unwrapList(await client.get(`/services?ownerId=${config.ownerId}&limit=100`), 'service');
  let service = findByName(services, spec.name);
  if (service && PROD_SERVICE_IDS.has(service.id)) {
    throw new Error(`refusing to touch production service ${service.id}`);
  }
  let plan = service?.serviceDetails?.plan || spec.plan;
  if (!service) {
    if (dryRun) {
      log(`dry-run: would create ${spec.type} ${spec.name}`);
      return null;
    }
    const created = await createService(client, log, spec);
    service = created.result?.service ?? created.result;
    plan = created.plan;
    log(`created ${spec.type} ${spec.name} (${service.id}) on plan ${plan ?? 'n/a'}`);
    if (plan === 'free') {
      log(`warning: ${spec.type} ${spec.name} is on the free plan and spins down when idle`);
    }
  } else {
    const currentPlan = service?.serviceDetails?.plan;
    log(`reusing ${spec.type} ${spec.name} (${service.id}) on plan ${currentPlan ?? 'unknown'}`);
    if (!dryRun) {
      if (spec.plan && currentPlan === 'free' && spec.plan !== 'free') {
        const recreated = await recreateService(client, log, spec, service);
        service = recreated.result?.service ?? recreated.result;
        plan = recreated.plan;
      } else if (spec.plan) {
        const patched = await withPlanFallback(
          (candidate) => client.patch(`/services/${service.id}`, spec.patchBody(candidate)),
          planCandidates(spec.plan, spec.fallbacks),
          `${spec.type} ${spec.name}`,
          log,
        );
        service = patched.result?.service ?? patched.result ?? service;
        plan = patched.plan;
      } else {
        const patched = await client.patch(`/services/${service.id}`, spec.patchBody());
        service = patched?.service ?? patched ?? service;
      }
    }
  }
  return { service, plan };
}

async function createService(client, log, spec) {
  const variants = spec.createBodies || [spec.createBody];
  let lastError = null;
  for (const variant of variants) {
    const build = typeof variant === 'function' ? variant : () => variant;
    try {
      if (spec.plan) {
        return await withPlanFallback(
          (candidate) => client.post('/services', build(candidate)),
          planCandidates(spec.plan, spec.fallbacks),
          `${spec.type} ${spec.name}`,
          log,
        );
      }
      return { result: await client.post('/services', build()), plan: null };
    } catch (error) {
      lastError = error;
      log(`${spec.type} ${spec.name} creation failed: ${error.message}`);
      if (![400, 422].includes(error.status)) throw error;
    }
  }
  throw lastError;
}

async function recreateService(client, log, spec, service) {
  log(`recreating ${spec.name}: Render cannot move a free service to a paid plan`);
  await client.request('DELETE', `/services/${service.id}`);
  await sleep(15000);
  return createService(client, log, spec);
}

async function applyStaticSiteRules(client, serviceId, log) {
  try {
    await client.put(`/services/${serviceId}/routes`, WEB_ROUTES);
    await client.put(`/services/${serviceId}/headers`, WEB_HEADERS);
    log(`applied the SPA rewrite and cache headers to ${serviceId}`);
  } catch (error) {
    log(`could not apply the static site rules to ${serviceId}: ${error.message}`);
  }
}

async function getEnvVars(client, serviceId) {
  const items = unwrapList(await client.get(`/services/${serviceId}/env-vars?limit=100`), 'envVar');
  return items.filter((item) => typeof item.key === 'string');
}

async function putEnvVars(client, serviceId, vars, log) {
  const body = vars.map((item) => ({ key: item.key, value: item.value }));
  await client.put(`/services/${serviceId}/env-vars`, body, { sensitive: true });
  log(`updated ${vars.length} environment variables on ${serviceId}`);
}

async function deployAndWait(client, serviceId, commit, log, timeoutMs = 2400000) {
  const body = { clearCache: 'do_not_clear' };
  if (commit) body.commitId = commit;
  const created = await client.post(`/services/${serviceId}/deploys`, body);
  const deploy = created?.deploy ?? created;
  log(`queued deploy ${deploy?.id ?? 'unknown'} for ${serviceId}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = unwrapList(await client.get(`/services/${serviceId}/deploys?limit=1`), 'deploy');
    const latest = list[0];
    const status = latest?.status;
    if (status === 'live') {
      log(`deploy ${latest.id} is live for ${serviceId}`);
      return { id: latest.id, status };
    }
    if (FAILED_DEPLOY_STATUSES.has(status)) {
      throw new Error(`deploy ${latest.id} for ${serviceId} ended as ${status}`);
    }
    log(`deploy ${latest?.id ?? 'unknown'} status: ${status ?? 'unknown'}`);
    await sleep(20000);
  }
  throw new Error(`deploy for ${serviceId} did not go live in time`);
}

async function waitForHealth(url, log, timeoutMs = 900000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'timeout';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, { headers: { Accept: 'application/json' } });
      const text = await response.text();
      if (response.ok) {
        const payload = JSON.parse(text);
        if (payload?.status === 'ok') return payload;
        last = `status=${payload?.status} services=${JSON.stringify(payload?.services ?? {})}`;
      } else {
        last = `HTTP ${response.status}`;
      }
    } catch (error) {
      last = error.message;
    }
    log(`waiting for ${url}/api/health (${last})`);
    await sleep(15000);
  }
  throw new Error(`staging API health never reached ok: ${last}`);
}

async function waitForWeb(url, log, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'timeout';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Accept: 'text/html' } });
      last = `HTTP ${response.status}`;
      if (response.ok) return response.status;
    } catch (error) {
      last = error.message;
    }
    log(`waiting for ${url} (${last})`);
    await sleep(15000);
  }
  throw new Error(`staging web never returned 200: ${last}`);
}

function parseArgs(argv) {
  const args = { dryRun: false, skipDeploy: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--skip-deploy') args.skipDeploy = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/provision-flyby-staging.mjs [--dry-run] [--skip-deploy]',
    '',
    'Required environment: RENDER_API_KEY',
    'Optional environment: RENDER_OWNER_ID, FLYBY_REPO, FLYBY_BRANCH, FLYBY_COMMIT,',
    'STAGING_REGION, STAGING_API_PLAN, STAGING_POSTGRES_PLAN, STAGING_KEY_VALUE_PLAN,',
    'STAGING_POSTGRES_VERSION, STAGING_NODE_VERSION, STAGING_REPORT_PATH',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const log = (message) => console.log(`[provision] ${message}`);
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) {
    throw new Error('RENDER_API_KEY is required');
  }
  const config = buildConfig();
  const client = new RenderClient(apiKey, { dryRun: args.dryRun });
  const ownerId = await resolveOwnerId(client, config, log);
  config.ownerId = ownerId;

  const failures = [];
  const attempt = async (label, operation) => {
    try {
      return await operation();
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
      log(`${label} failed: ${error.message}`);
      return null;
    }
  };

  const keyValue = await attempt('key value', () => ensureKeyValue(client, config, log, args.dryRun));

  const apiServiceResult = await attempt('api service', () =>
    ensureService(client, config, log, args.dryRun, {
      name: config.apiServiceName,
      type: 'web_service',
      plan: config.apiPlan,
      fallbacks: API_PLAN_FALLBACKS,
      createBodies: [(plan) => buildApiServicePayload(config, plan)],
      patchBody: (plan) => buildApiServicePatch(config, plan),
    }),
  );
  const apiService = apiServiceResult?.service ?? null;

  const webServiceResult = await attempt('web service', () =>
    ensureService(client, config, log, args.dryRun, {
      name: config.webServiceName,
      type: 'static_site',
      plan: null,
      fallbacks: [],
      createBodies: [
        () => buildWebServicePayload(config, 'minimal'),
        () => buildWebServicePayload(config, 'previews'),
        () => buildWebServicePayload(config, 'full'),
      ],
      patchBody: () => buildWebServicePatch(config),
    }),
  );
  const webService = webServiceResult?.service ?? null;
  if (webService && !args.dryRun) {
    await applyStaticSiteRules(client, webService.id, log);
  }

  const postgres = await attempt('postgres', () => ensurePostgres(client, config, log, args.dryRun));
  const postgresError = postgres
    ? null
    : failures.find((entry) => entry.startsWith('postgres: '))?.slice('postgres: '.length) || 'unknown';

  const apiUrl = apiService ? serviceUrl(apiService, config.apiServiceName) : `https://${config.apiServiceName.toLowerCase()}.onrender.com`;
  const webUrl = webService ? serviceUrl(webService, config.webServiceName) : `https://${config.webServiceName.toLowerCase()}.onrender.com`;

  if (args.dryRun) {
    log(`dry-run: api url ${apiUrl}`);
    log(`dry-run: web url ${webUrl}`);
    return;
  }

  let apiEnvVars = [];
  let vapidGenerated = false;
  if (apiService) {
    const apiEnvExisting = await getEnvVars(client, apiService.id);
    const existingMap = new Map(apiEnvExisting.map((item) => [item.key, item.value]));
    const vapid = pickVapid(existingMap);
    vapidGenerated = vapid.generated;
    if (vapid.generated) log('generated a fresh VAPID key pair for staging');
    apiEnvVars = buildApiEnvVars(apiEnvExisting, {
      databaseUrl: postgres?.internalConnectionString || '',
      redisUrl: keyValue?.internalConnectionString || '',
      allowedOrigins: mergeOrigins(existingMap.get('ALLOWED_ORIGINS'), webUrl),
      vapid,
      jwtSecret: existingMap.get('JWT_SECRET') || randomBytes(32).toString('hex'),
      adminApiKey: existingMap.get('ADMIN_API_KEY') || randomBytes(32).toString('hex'),
      nodeVersion: config.nodeVersion,
    });
    if (postgres && keyValue) {
      await putEnvVars(client, apiService.id, apiEnvVars, log);
    } else {
      log('skipping the API environment update: the staging Postgres or Key Value is not available');
    }
  }

  let webEnvVars = [];
  if (webService) {
    webEnvVars = buildWebEnvVars(await getEnvVars(client, webService.id), apiUrl);
    await putEnvVars(client, webService.id, webEnvVars, log);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    repo: config.repo,
    branch: config.branch,
    commit: config.commit || null,
    region: config.region,
    plans: {
      api: apiServiceResult?.plan ?? config.apiPlan,
      postgres: postgres?.plan ?? config.postgresPlan,
      keyValue: keyValue?.plan ?? config.keyValuePlan,
    },
    postgresId: postgres?.id ?? null,
    postgresError,
    keyValueId: keyValue?.id ?? null,
    apiServiceId: apiService?.id ?? null,
    webServiceId: webService?.id ?? null,
    apiUrl,
    webUrl,
    apiEnvKeys: apiEnvVars.map((item) => item.key).sort(),
    webEnvKeys: webEnvVars.map((item) => item.key).sort(),
    vapidGenerated,
    failures,
  };

  if (!args.skipDeploy) {
    if (apiService && postgres && keyValue) {
      report.apiDeploy = await deployAndWait(client, apiService.id, config.commit, log);
      report.health = await waitForHealth(apiUrl, log);
    } else {
      log('skipping the API deploy: the staging Postgres or Key Value is not available');
    }
    if (webService) {
      report.webDeploy = await deployAndWait(client, webService.id, config.commit, log);
      report.webStatus = await waitForWeb(webUrl, log);
    }
  }

  if (config.reportPath) {
    writeFileSync(config.reportPath, `${JSON.stringify(report, null, 2)}\n`);
    log(`wrote ${config.reportPath}`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    throw new Error(`staging provisioning is incomplete: ${failures.join(' | ')}`);
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[provision] failed: ${error.message}`);
    process.exitCode = 1;
  });
}
