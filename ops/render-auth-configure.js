const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const api = process.env.RENDER_API;
const renderKey = process.env.RENDER_API_KEY;
const backendId = process.env.TARGET_BACKEND_ID;
const frontendId = process.env.TARGET_FRONTEND_ID;
const issuer = process.env.CLERK_ISSUER;
const instance = process.env.CLERK_INSTANCE;
const publicKey = process.env.CLERK_JWT_PUBLIC_KEY;
const githubPublishable = process.env.GITHUB_CLERK_PUBLISHABLE_KEY;
const clerkApi = process.env.CLERK_API || 'https://api.clerk.com/v1';

const result = { actions: [], diagnostics: [] };
const workDir = process.env.RENDER_AUTH_WORK_DIR || '/tmp';
const responseFile = `${workDir}/render-response.json`;
const putFile = `${workDir}/render-put.json`;
const putMinimalFile = `${workDir}/render-put-minimal.json`;
const resultFile = `${workDir}/configure-result.json`;

function log(line) {
  console.log(line);
  result.diagnostics.push(line);
}

function request(method, path, bodyFile) {
  const args = [
    '-sS',
    '-o',
    responseFile,
    '-w',
    '%{http_code}',
    '-X',
    method,
    '-H',
    `Authorization: Bearer ${renderKey}`,
  ];
  if (bodyFile) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', `@${bodyFile}`);
  }
  args.push(`${api}${path}`);
  try {
    return execFileSync('curl', args, { encoding: 'utf8' }).trim();
  } catch (error) {
    const stderr = (error.stderr || '').toString().split('\n')[0];
    return `error:${stderr}`;
  }
}

function normalize(list) {
  return (Array.isArray(list) ? list : []).map((entry) => entry.envVar || entry);
}

function readResponse() {
  return JSON.parse(fs.readFileSync(responseFile, 'utf8'));
}

function listEnvVars(serviceId) {
  const status = request('GET', `/services/${serviceId}/env-vars`);
  log(`GET env-vars -> HTTP ${status}`);
  if (status !== '200') return null;
  return normalize(readResponse());
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function clerkInstance(keyValue) {
  if (!keyValue) return '';
  const parts = keyValue.split('_');
  if (parts.length < 3) return '';
  const body = parts.slice(2).join('_').replace(/[^A-Za-z0-9_-]/g, '');
  if (!body) return '';
  try {
    const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64url').toString('utf8');
    return decoded.replace(/\$$/, '');
  } catch (error) {
    return '';
  }
}

async function clerkRequest(method, path, body, secretKey) {
  const options = {
    method,
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${process.env.CLERK_API || 'https://api.clerk.com/v1'}${path}`, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

async function getFrontendSecretKey() {
  if (!frontendId) {
    log('FRONTEND_SERVICE_ID not provided, cannot read frontend env vars');
    return null;
  }

  const envVars = await listEnvVars(frontendId);
  if (!envVars) {
    log('Failed to read frontend environment variables');
    return null;
  }

  const secret = envVars.find((entry) => entry.key === 'CLERK_SECRET_KEY');
  if (!secret || !secret.value) {
    log('CLERK_SECRET_KEY not found on frontend service');
    return null;
  }

  const publishable = envVars.find((entry) => entry.key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  const publishableInstance = clerkInstance(publishable?.value || '');
  log(`frontend publishable key instance: ${publishableInstance || 'unknown'}`);
  if (!publishableInstance || publishableInstance !== instance) {
    log('frontend publishable key belongs to a different Clerk instance');
    return null;
  }

  return String(secret.value).trim();
}

function replaceEnvVars(serviceId, current, additions) {
  const missing = current.filter((entry) => entry.value === null || entry.value === undefined).map((entry) => entry.key);
  if (missing.length) {
    log(`refused the bulk replace, the API did not return the value of: ${missing.join(',')}`);
    return { ok: false, refused: true };
  }
  const additionsKeys = additions.map((addition) => addition.key);
  const beforeHashes = current
    .filter((entry) => !additionsKeys.includes(entry.key))
    .map((entry) => `${entry.key}\t${hash(entry.value)}`)
    .sort();
  const keep = current.filter((entry) => !additionsKeys.includes(entry.key));
  const withType = keep.map((entry) => (
    entry.type
      ? { key: entry.key, value: String(entry.value), type: entry.type }
      : { key: entry.key, value: String(entry.value) }
  ));
  const minimal = keep.map((entry) => ({ key: entry.key, value: String(entry.value) }));
  fs.writeFileSync(putFile, JSON.stringify(withType.concat(additions)));
  let status = request('PUT', `/services/${serviceId}/env-vars`, putFile);
  log(`PUT env-vars -> HTTP ${status}`);
  if (status !== '200' && status !== '201') {
    fs.writeFileSync(putMinimalFile, JSON.stringify(minimal.concat(additions)));
    status = request('PUT', `/services/${serviceId}/env-vars`, putMinimalFile);
    log(`PUT env-vars with a minimal body -> HTTP ${status}`);
  }
  if (status !== '200' && status !== '201') return { ok: false };
  const after = listEnvVars(serviceId);
  if (!after) return { ok: true, verified: false };
  const afterHashes = after
    .filter((entry) => !additionsKeys.includes(entry.key))
    .map((entry) => `${entry.key}\t${hash(entry.value)}`)
    .sort();
  const beforeMap = new Map(beforeHashes.map((line) => line.split('\t')));
  const afterMap = new Map(afterHashes.map((line) => line.split('\t')));
  const changed = [...beforeMap.keys()].filter((key) => afterMap.get(key) !== beforeMap.get(key));
  const vanished = [...beforeMap.keys()].filter((key) => !afterMap.has(key));
  const appeared = [...afterMap.keys()].filter((key) => !beforeMap.has(key));
  if (vanished.length) log(`variables that disappeared: ${vanished.join(',')}`);
  if (appeared.length) log(`variables that appeared without being added by this run: ${appeared.join(',')}`);
  if (changed.length) log(`pre-existing variables with a different value: ${changed.join(',')}`);
  const unchanged = changed.length === 0 && vanished.length === 0 && appeared.length === 0;
  log(unchanged
    ? 'every pre-existing variable kept exactly the same value, verified by hash'
    : 'the verification found a difference in the pre-existing variables');
  return { ok: true, verified: unchanged };
}

async function run() {
  const frontendSecretKey = await getFrontendSecretKey();
  if (!frontendSecretKey) {
    result.actions.push('failed to obtain CLERK_SECRET_KEY from frontend service');
    fs.writeFileSync(resultFile, JSON.stringify(result));
    process.exit(1);
  }

  const backend = listEnvVars(backendId);
  if (backend) {
    log(`backend env var object keys: ${backend.length ? Object.keys(backend[0]).join(',') : 'empty'}`);
    const additions = [
      { key: 'CLERK_JWT_ISSUER', value: issuer },
      { key: 'CLERK_JWT_PUBLIC_KEY', value: publicKey },
    ];

    const outcome = replaceEnvVars(backendId, backend, additions);
    if (outcome.ok) {
      result.actions.push('added CLERK_JWT_ISSUER and CLERK_JWT_PUBLIC_KEY to the backend service');
    }
    if (outcome.refused) {
      result.actions.push('refused the backend bulk replace because the API did not return every value');
    }
    if (outcome.ok && outcome.verified === false) {
      result.actions.push('the backend variables were written but could not be verified');
    }
  } else {
    result.actions.push('could not read the backend environment variables');
  }

  fs.writeFileSync(resultFile, JSON.stringify(result));
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Configuration failed:', error);
    process.exit(1);
  });
}

module.exports = { clerkInstance, hash, normalize, replaceEnvVars, run };