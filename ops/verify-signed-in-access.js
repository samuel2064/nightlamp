const fs = require('fs');
const { execFileSync } = require('child_process');

const renderApi = process.env.RENDER_API || 'https://api.render.com/v1';
const renderKey = process.env.RENDER_API_KEY;
const frontendId = process.env.RENDER_FRONTEND_SERVICE_ID || process.env.FRONTEND_SERVICE_ID;
const clerkApi = process.env.CLERK_API || 'https://api.clerk.com/v1';
const expectedInstance = process.env.CLERK_INSTANCE;
const expectedIssuer = process.env.CLERK_ISSUER;
const nightlampApi = process.env.NIGHTLAMP_API || 'https://nightlamp-api.onrender.com';
const resultFile = process.env.RESULT_FILE || '/tmp/signed-in-result.json';
const marker = process.env.VERIFICATION_MARKER || 'nightlamp-cto-verification';
const emailDomain = process.env.VERIFICATION_EMAIL_DOMAIN || 'example.com';

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
const runStartedAt = Date.now();

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
    const decoded = Buffer.from(body + '='.repeat((4 - (body.length % 4)) % 4), 'base64url').toString('utf8');
    return decoded.replace(/\$$/, '');
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

function errorCodes(response) {
  const body = response.body;
  if (!body || typeof body !== 'object') return [];
  const codes = [];
  if (typeof body.code === 'string') codes.push(body.code);
  if (Array.isArray(body.errors)) {
    for (const entry of body.errors) {
      if (entry && typeof entry.code === 'string') codes.push(entry.code);
      if (entry && typeof entry.field === 'string') codes.push(`${entry.field}:invalid`);
    }
  }
  return codes;
}

function readPreviousSessionId() {
  try {
    const output = execFileSync('git', ['show', 'origin/ops/render-auth-report:reports/signed-in-verification.json'], { encoding: 'utf8' });
    const previous = JSON.parse(output);
    const id = previous && previous.identity && previous.identity.sessionId;
    return typeof id === 'string' && id ? id : null;
  } catch (error) {
    return null;
  }
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
  const publishable = variables.find((entry) => entry.key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  report.identity.frontendHasClerkSecret = Boolean(secret && secret.value);
  report.identity.frontendHasPublishableKey = Boolean(publishable && publishable.value);
  if (!secret || !secret.value) {
    report.error = 'CLERK_SECRET_KEY is not set on the frontend service';
    return;
  }
  if (!publishable || !publishable.value) {
    report.error = 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set on the frontend service';
    return;
  }
  const publishableInstance = clerkInstance(String(publishable.value).trim());
  log(`the frontend publishable key belongs to the Clerk instance: ${publishableInstance || 'unknown'}`);
  if (!publishableInstance || publishableInstance !== expectedInstance) {
    report.error = 'the frontend publishable key belongs to a different Clerk instance';
    return;
  }
  secretKey = String(secret.value).trim();

  const users = await clerkRequest('GET', '/users?limit=20');
  log(`GET the Clerk users -> HTTP ${users.status}`);
  if (users.status !== 200) {
    report.error = 'the Clerk Backend API did not accept the secret key';
    return;
  }
  const existingUsers = Array.isArray(users.body) ? users.body.length : 0;
  report.identity.existingUserCount = existingUsers;

  const email = `${marker}-${Date.now()}@${emailDomain}`;
  const password = `Nv${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const variants = [
    { email_address: email, first_name: 'Nightlamp', last_name: 'Verification' },
    { email_address: email, first_name: 'Nightlamp', last_name: 'Verification', password },
  ];
  let created = { status: 0, body: null };
  const creationErrors = [];
  for (const variant of variants) {
    created = await clerkRequest('POST', '/users', variant);
    const codes = errorCodes(created);
    log(`POST the verification user${variant.password ? ' with a password' : ' without a password'} -> HTTP ${created.status}${codes.length ? ` (${codes.join(', ')})` : ''}`);
    creationErrors.push(`${variant.password ? 'with-password' : 'without-password'}:${created.status}${codes.length ? `:${codes.join(',')}` : ''}`);
    if (created.status >= 200 && created.status < 300 && created.body && created.body.id) break;
  }
  report.identity.verificationEmailDomain = emailDomain;
  report.identity.creationAttempts = creationErrors;
  if (created.status >= 200 && created.status < 300 && created.body && created.body.id) {
    userId = created.body.id;
    report.identity.userId = userId;
    report.identity.identityCreated = true;
  } else {
    const existing = Array.isArray(users.body) ? users.body.find((entry) => entry && entry.id) : null;
    if (!existing) {
      report.error = `the verification identity could not be created (HTTP ${created.status}${errorCodes(created).length ? `: ${errorCodes(created).join(', ')}` : ''}) and there is no existing user to fall back to`;
      return;
    }
    userId = existing.id;
    report.identity.userId = userId;
    report.identity.identityCreated = false;
    report.identity.usedExistingUser = true;
    log('falling back to an existing user for the session; that user will not be deleted');
  }

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
  report.identity.sessionId = sessionId;
  let claims = {};
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch (error) {
    claims = {};
  }
  report.identity.tokenClaims = Object.keys(claims).sort();
  report.identity.tokenIssuer = typeof claims.iss === 'string' ? claims.iss : null;
  if (report.identity.tokenIssuer !== expectedIssuer) {
    report.error = 'the minted token does not come from the expected Clerk instance';
    return;
  }
  log('the minted token comes from the expected Clerk instance');

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
  const previous = readPreviousSessionId();
  if (previous) {
    const response = await clerkRequest('POST', `/sessions/${previous}/revoke`, {});
    log(`POST revoke the session published by the previous run -> HTTP ${response.status}`);
    report.identity.previousSessionRevoked = response.status === 204 || response.status === 200;
  }
  if (sessionId) {
    const revoked = await clerkRequest('POST', `/sessions/${sessionId}/revoke`, {});
    log(`POST revoke the verification session -> HTTP ${revoked.status}`);
    report.identity.sessionRemoved = revoked.status === 204 || revoked.status === 200;
    if (!report.identity.sessionRemoved) {
      const removed = await clerkRequest('DELETE', `/sessions/${sessionId}`);
      log(`DELETE the verification session -> HTTP ${removed.status}`);
      report.identity.sessionRemoved = removed.status === 204 || removed.status === 200;
    }
  }
  if (userId && report.identity.identityCreated) {
    const removed = await clerkRequest('DELETE', `/users/${userId}`);
    log(`DELETE the verification user -> HTTP ${removed.status}`);
    report.identity.userRemoved = removed.status === 204 || removed.status === 200;
  } else if (userId) {
    log('the existing user is not deleted by this script');
    report.identity.userRemoved = false;
    report.identity.existingUserKept = true;
    const sessions = await clerkRequest('GET', `/users/${userId}/sessions?limit=20`);
    const list = Array.isArray(sessions.body) ? sessions.body : [];
    let revoked = 0;
    for (const session of list) {
      if (!session || !session.id || !session.created_at) continue;
      const createdAt = Date.parse(session.created_at);
      if (!Number.isFinite(createdAt) || createdAt < runStartedAt) continue;
      const response = await clerkRequest('POST', `/sessions/${session.id}/revoke`, {});
      log(`POST revoke a leftover session from an earlier run -> HTTP ${response.status}`);
      if (response.status === 204 || response.status === 200) revoked += 1;
    }
    report.identity.leftoverSessionsRevoked = revoked;
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
