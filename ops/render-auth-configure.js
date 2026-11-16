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
const githubSecret = process.env.GITHUB_CLERK_SECRET_KEY;

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
    return Buffer.from(body + '='.repeat((4 - (body.length % 4)) % 4), 'base64url').toString('utf8');
  } catch (error) {
    return '';
  }
}

function replaceEnvVars(serviceId, current, additions) {
  const missing = current.filter((entry) => entry.value === null || entry.value === undefined).map((entry) => entry.key);
  if (missing.length) {
    log(`refused the bulk replace, the API did not return the value of: ${missing.join(',')}`);
    return { ok: false, refused: true };
  }
  const beforeHashes = current.map((entry) => `${entry.key}\t${hash(entry.value)}`).sort();
  const keep = current.filter((entry) => !additions.some((addition) => addition.key === entry.key));
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
    .filter((entry) => !additions.some((addition) => addition.key === entry.key))
    .map((entry) => `${entry.key}\t${hash(entry.value)}`)
    .sort();
  const unchanged = JSON.stringify(beforeHashes) === JSON.stringify(afterHashes);
  log(unchanged
    ? 'every pre-existing variable kept exactly the same value, verified by hash'
    : 'a pre-existing variable changed value');
  return { ok: true, verified: unchanged };
}

function run() {
  const backend = listEnvVars(backendId);
  if (backend) {
    log(`backend env var object keys: ${backend.length ? Object.keys(backend[0]).join(',') : 'empty'}`);
    const outcome = replaceEnvVars(backendId, backend, [
      { key: 'CLERK_JWT_ISSUER', value: issuer },
      { key: 'CLERK_JWT_PUBLIC_KEY', value: publicKey },
    ]);
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

  if (frontendId) {
    const frontend = listEnvVars(frontendId);
    if (frontend) {
      const additions = [];
      const publishableInstance = clerkInstance(githubPublishable);
      const secretInstance = clerkInstance(githubSecret);
      log(`github publishable key instance: ${publishableInstance || 'unknown'}`);
      log(`github secret key instance: ${secretInstance || 'unknown'}`);
      if (!frontend.some((entry) => entry.key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY')) {
        if (publishableInstance === instance) {
          additions.push({ key: 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', value: githubPublishable });
        } else {
          result.actions.push('refused NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY because the instance does not match');
        }
      }
      if (!frontend.some((entry) => entry.key === 'CLERK_SECRET_KEY')) {
        if (secretInstance === instance) {
          additions.push({ key: 'CLERK_SECRET_KEY', value: githubSecret });
        } else {
          result.actions.push('refused CLERK_SECRET_KEY because the instance does not match');
        }
      }
      if (additions.length) {
        const outcome = replaceEnvVars(frontendId, frontend, additions);
        if (outcome.ok) {
          result.actions.push('added the missing Clerk variables to the frontend service');
        }
      } else {
        result.actions.push('the frontend Clerk variables were already present, nothing changed');
      }
    }
  }

  fs.writeFileSync(resultFile, JSON.stringify(result));
}

if (require.main === module) {
  run();
}

module.exports = { clerkInstance, hash, normalize, replaceEnvVars, run };
