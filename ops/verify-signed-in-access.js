const fs = require('fs');

const renderApi = process.env.RENDER_API || 'https://api.render.com/v1';
const renderKey = process.env.RENDER_API_KEY;
const frontendId = process.env.RENDER_FRONTEND_SERVICE_ID || process.env.FRONTEND_SERVICE_ID;
const clerkApi = process.env.CLERK_API || 'https://api.clerk.com/v1';
const expectedInstance = process.env.CLERK_INSTANCE;
const nightlampApi = process.env.NIGHTLAMP_API || 'https://nightlamp-api.onrender.com';
const resultFile = process.env.RESULT_FILE || '/tmp/signed-in-result.json';
const marker = process.env.VERIFICATION_MARKER || 'nightlamp-cto-verification';

const report = {
  probes: [],
  identity: {},
  diagnostics: [],
  valuesIncluded: false,
  bodiesIncluded: false,
};

let secretKey = null;
let sessionId = null;
let userId = null;

function log(line) {
  console.log(line);
  report.diagnostics.push(line);
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

async function request(base, method, path, key, body) {
  const options = {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  return { status: response.status, body: parsed };
}

function renderRequest(method, path, body) {
  return request(renderApi, method, path, renderKey, body);
}

function clerkRequest(method, path, body) {
  return request(clerkApi, method, path, secretKey, body);
}

async function probe(label, url, options, expected) {
  const response = await fetch(url, options);
  const text = await response.text();
  let code = null;
  try {
    const parsed = JSON.parse(text);
    code = typeof parsed.code === 'string' ? parsed.code : null;
  } catch (error) {
    code = null;
  }
  const entry = {
    label,
    expected,
    status: response.status,
    code,
    ok: expected.includes(response.status),
  };
  report.probes.push(entry);
  log(`${entry.ok ? 'PASS' : 'FAIL'} ${label} expected ${expected.join('/')} got ${response.status}${code ? ` ${code}` : ''}`);
  return entry;
}

function bearer(token, extraHeaders) {
  return Object.assign({ Authorization: `Bearer ${token}` }, extraHeaders || {});
}

async function run() {
  const envVars = await renderRequest('GET', `/services/${frontendId}/env-vars`);
  log(`GET the frontend environment variables -> HTTP ${envVars.status}`);
  if (envVars.status !== 200) {
    report.error = 'the frontend environment variables could not be read';
    return;
  }
  const variables = (Array.isArray(envVars.body) ? envVars.body : []).map((entry) => entry.envVar || entry);
  const secret = variables.find((entry) => entry.key === 'CLERK_SECRET_KEY');
  report.identity.frontendHasClerkSecret = Boolean(secret && secret.value);
  report.identity.frontendHasPublishableKey = variables.some((entry) => entry.key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  if (!secret || !secret.value) {
    report.error = 'CLERK_SECRET_KEY is not set on the frontend service';
    return;
  }
  secretKey = String(secret.value).trim();
  const instance = clerkInstance(secretKey);
  log(`the frontend secret key belongs to the Clerk instance: ${instance || 'unknown'}`);
  if (!instance || instance !== expectedInstance) {
    report.error = 'the frontend secret key belongs to a different Clerk instance';
    return;
  }

  const users = await clerkRequest('GET', '/users?limit=20');
  log(`GET the Clerk users -> HTTP ${users.status}`);
  if (users.status !== 200) {
    report.error = 'the Clerk Backend API did not accept the secret key';
    return;
  }
  const existingUsers = Array.isArray(users.body) ? users.body.length : 0;
  report.identity.existingUserCount = existingUsers;

  const email = `${marker}-${Date.now()}@nightlamp.local`;
  const created = await clerkRequest('POST', '/users', {
    email_address: email,
    first_name: 'Nightlamp',
    last_name: 'Verification',
    password: `Nv${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  log(`POST the verification user -> HTTP ${created.status}`);
  if (created.status < 200 || created.status >= 300 || !created.body || !created.body.id) {
    report.error = `the verification identity could not be created (HTTP ${created.status})`;
    return;
  }
  userId = created.body.id;
  report.identity.userId = userId;
  report.identity.identityCreated = true;

  const session = await clerkRequest('POST', '/sessions', { user_id: userId });
  log(`POST a session for the verification user -> HTTP ${session.status}`);
  if (session.status < 200 || session.status >= 300 || !session.body || !session.body.id) {
    report.error = `a session could not be created for the verification identity (HTTP ${session.status})`;
    return;
  }
  sessionId = session.body.id;

  const tokenResponse = await clerkRequest('POST', `/sessions/${sessionId}/tokens`, {});
  log(`POST a session token -> HTTP ${tokenResponse.status}`);
  const token = tokenResponse.body && tokenResponse.body.jwt;
  if (tokenResponse.status < 200 || tokenResponse.status >= 300 || !token) {
    report.error = `a session token could not be minted (HTTP ${tokenResponse.status})`;
    return;
  }
  report.identity.tokenMinted = true;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    report.identity.tokenClaims = Object.keys(payload).sort();
  } catch (error) {
    report.identity.tokenClaims = [];
  }

  const json = { 'Content-Type': 'application/json' };
  await probe(
    'a signed-in user with no team can list the events',
    `${nightlampApi}/api/events`,
    { headers: bearer(token) },
    [200],
  );
  await probe(
    'a signed-in user with no team can list the remediation runs',
    `${nightlampApi}/api/remediation/runs`,
    { headers: bearer(token) },
    [200],
  );
  await probe(
    'acknowledging an event that does not exist answers 404, not 200',
    `${nightlampApi}/api/events/acknowledge`,
    { method: 'POST', headers: bearer(token, json), body: JSON.stringify({ id: 'nightlamp-verification-unknown-id' }) },
    [404],
  );
  await probe(
    'a tenant the user is not a member of is refused with 403',
    `${nightlampApi}/api/events`,
    { headers: bearer(token, { 'x-nightlamp-team-id': `nightlamp-verification-team-${Date.now()}` }) },
    [403],
  );
  await probe(
    'an admin route is refused with 403 for a user without a role',
    `${nightlampApi}/api/remediation/approve`,
    { method: 'POST', headers: bearer(token, json), body: JSON.stringify({ id: 'nightlamp-verification-unknown-id' }) },
    [403],
  );
  await probe(
    'a token that is not valid is refused with 401',
    `${nightlampApi}/api/events`,
    { headers: bearer('not-a-real-token') },
    [401],
  );
}

async function cleanup() {
  if (sessionId) {
    const removed = await clerkRequest('DELETE', `/sessions/${sessionId}`);
    log(`DELETE the verification session -> HTTP ${removed.status}`);
    report.identity.sessionRemoved = removed.status === 204 || removed.status === 200;
  }
  if (userId) {
    const removed = await clerkRequest('DELETE', `/users/${userId}`);
    log(`DELETE the verification user -> HTTP ${removed.status}`);
    report.identity.userRemoved = removed.status === 204 || removed.status === 200;
  }
}

async function main() {
  try {
    await run();
  } catch (error) {
    report.error = `the verification script failed: ${(error && error.message) || 'unknown error'}`;
    log(report.error);
  } finally {
    try {
      await cleanup();
    } catch (error) {
      log(`the cleanup failed: ${(error && error.message) || 'unknown error'}`);
    }
    const passed = report.probes.filter((entry) => entry.ok).length;
    report.probesPassed = passed;
    report.probesTotal = report.probes.length;
    fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
    log(`probes as expected: ${passed}/${report.probes.length}`);
  }
}

main();
