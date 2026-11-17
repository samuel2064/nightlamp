'use strict';

const fs = require('fs');

const RENDER_API = process.env.RENDER_API || 'https://api.render.com/v1';
const RENDER_KEY = process.env.RENDER_API_KEY || '';
const BACKEND_SERVICE_ID = process.env.BACKEND_SERVICE_ID || '';
const FRONTEND_SERVICE_ID = process.env.FRONTEND_SERVICE_ID || '';
const CLERK_API = process.env.CLERK_API || 'https://api.clerk.com/v1';
const CLERK_API_VERSION = process.env.CLERK_API_VERSION || '2025-04-10';
const BACKEND_URL = (process.env.BACKEND_URL || 'https://nightlamp-api.onrender.com').replace(/\/+$/, '');
const REPORT_FILE = process.env.REPORT_FILE || '/tmp/signed-in-verify-report.json';
const RUN_ID = process.env.GITHUB_RUN_ID || 'local';
const TEST_EMAIL = process.env.TEST_EMAIL || `noc263-verify-${RUN_ID}@nightlamp.test`;

const report = {
  run: RUN_ID,
  startedAt: new Date().toISOString(),
  backendUrl: BACKEND_URL,
  probes: [],
  steps: [],
  findings: [],
  clerkToken: null,
  testUser: null,
  createdArtifacts: [],
  valuesIncluded: false,
  finished: false,
};

function step(name, detail) {
  report.steps.push({ name, detail: String(detail).slice(0, 300) });
}

function finding(text) {
  report.findings.push(String(text).slice(0, 300));
}

function scrub(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/sk_[A-Za-z0-9_-]+/g, 'sk_[redacted]')
    .replace(/pk_[A-Za-z0-9_-]+/g, 'pk_[redacted]')
    .slice(0, 160);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text };
  } catch (err) {
    return { status: 0, json: null, text: `error:${scrub(err.message)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function renderEnvVars(serviceId) {
  const res = await fetchJson(`${RENDER_API}/services/${serviceId}/env-vars`, {
    headers: { Authorization: `Bearer ${RENDER_KEY}` },
  });
  if (res.status !== 200) {
    step('render-env-vars', `HTTP ${res.status}`);
    return new Map();
  }
  const list = Array.isArray(res.json) ? res.json : (res.json && res.json.envVars) || [];
  const map = new Map();
  for (const entry of list) {
    const item = entry && entry.envVar ? entry.envVar : entry;
    if (item && item.key) map.set(item.key, item.value);
  }
  step('render-env-vars', `HTTP 200, ${map.size} variables on service ${serviceId}`);
  return map;
}

function clerkInstanceFromPublishable(key) {
  if (!key) return '';
  const parts = key.split('_');
  if (parts.length < 3) return '';
  const body = parts.slice(2).join('_').replace(/[^A-Za-z0-9_-]/g, '');
  try {
    return Buffer.from(body + '='.repeat((4 - (body.length % 4)) % 4), 'base64url')
      .toString('utf8')
      .replace(/[^A-Za-z0-9.-]/g, '');
  } catch {
    return '';
  }
}

async function clerk(method, path, body, options = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.CLERK_SECRET_KEY_VALUE || ''}`,
    'Content-Type': 'application/json',
  };
  if (options.withVersion !== false) headers['Clerk-API-Version'] = CLERK_API_VERSION;
  return fetchJson(`${CLERK_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function clerkErrorSummary(res) {
  if (!res || !res.json || !Array.isArray(res.json.errors) || !res.json.errors.length) {
    return scrub(res && res.text ? res.text : 'no response');
  }
  const parts = res.json.errors.slice(0, 3).map((entry) => {
    const detail = entry.long_message || entry.message || '';
    return `${entry.code || ''}${entry.param ? `[${entry.param}]` : ''} ${detail}`.trim();
  });
  return `${res.status} ${parts.join(' | ')}`.slice(0, 500);
}

async function createClerkUser(emails) {
  const email = emails[0];
  const bodies = [
    { email_address: email },
    { email_address: [email] },
    { email_address: email, skip_email_verification: true },
    { email_address: email, username: `noc263-${RUN_ID}` },
    { email_address: email, first_name: 'Nightlamp', last_name: 'Verification' },
    { email_address: email, skip_email_verification: true, first_name: 'Nightlamp', last_name: 'Verification' },
  ];
  let first = true;
  for (const withVersion of [true, false]) {
    for (const body of bodies) {
      const res = await clerk('POST', '/users', body, { withVersion });
      if (res.json && res.json.id) {
        step('clerk-user-created', `${res.json.id} (${email})`);
        return res.json;
      }
      const detail = first ? scrub(JSON.stringify(res.json || res.text)).slice(0, 900) : clerkErrorSummary(res);
      first = false;
      step('clerk-user-create-attempt', `version=${withVersion ? CLERK_API_VERSION : 'default'} body=${Object.keys(body).sort().join('+')} -> ${detail}`);
    }
  }
  for (const alternative of emails.slice(1)) {
    const res = await clerk('POST', '/users', { email_address: alternative, skip_email_verification: true }, { withVersion: true });
    if (res.json && res.json.id) {
      step('clerk-user-created', `${res.json.id} (${alternative})`);
      return res.json;
    }
    step('clerk-user-create-attempt', `alternative address -> ${clerkErrorSummary(res)}`);
  }
  return null;
}

async function listClerkUsers() {
  const res = await clerk('GET', '/users?limit=20&order_by=-created_at', null, { withVersion: true });
  if (res.json && Array.isArray(res.json.data)) {
    step('clerk-user-list', `HTTP ${res.status}, ${res.json.data.length} users visible to the instance key`);
    return res.json.data.map((entry) => ({
      id: entry.id,
      email: Array.isArray(entry.email_addresses) && entry.email_addresses.length ? entry.email_addresses[0].email_address : '',
      createdAt: entry.created_at || null,
    }));
  }
  step('clerk-user-list', `HTTP ${res.status} ${scrub(JSON.stringify(res.json || res.text)).slice(0, 900)}`);
  return [];
}

function looksLikeTestIdentity(email) {
  return /(^|[@.+-])(test|noc|nightlamp|verify|ci|bot)([@.+-]|$)/i.test(String(email || ''));
}

function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    };
  } catch {
    return null;
  }
}

async function probe(name, path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.extraHeaders) Object.assign(headers, options.extraHeaders);
  const res = await fetchJson(`${BACKEND_URL}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const entry = {
    probe: name,
    method: options.method || 'GET',
    path,
    status: res.status,
  };
  if (options.expect !== undefined) {
    entry.contract = options.expect;
    entry.meetsContract = res.status === options.expect;
  }
  if (res.json && typeof res.json.count === 'number') entry.count = res.json.count;
  if (res.json && Array.isArray(res.json.teams)) entry.teamCount = res.json.teams.length;
  if (res.json && res.json.error) entry.error = scrub(res.json.error);
  if (res.json && res.json.code) entry.code = res.json.code;
  report.probes.push(entry);
  return res;
}

async function run() {
  if (!RENDER_KEY || !BACKEND_SERVICE_ID) {
    finding('the Render credentials are not available in this run');
    return;
  }

  const backendVars = await renderEnvVars(BACKEND_SERVICE_ID);
  const frontendVars = FRONTEND_SERVICE_ID ? await renderEnvVars(FRONTEND_SERVICE_ID) : new Map();
  const clerkSecret = backendVars.get('CLERK_SECRET_KEY') || frontendVars.get('CLERK_SECRET_KEY') || '';
  const publishable = frontendVars.get('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY') || '';
  const issuer = backendVars.get('CLERK_JWT_ISSUER') || '';
  process.env.CLERK_SECRET_KEY_VALUE = clerkSecret;

  if (!clerkSecret) {
    finding('no Clerk instance secret key is present on the backend or the frontend service');
    return;
  }
  if (!publishable) {
    finding('no Clerk publishable key is present on the frontend service');
  } else {
    const instance = clerkInstanceFromPublishable(publishable);
    const mode = publishable.startsWith('pk_test_') ? 'test' : publishable.startsWith('pk_live_') ? 'live' : 'unknown';
    step('clerk-instance', `mode=${mode} instance=${instance || 'unresolved'}`);
    if (mode === 'live') {
      finding('the production Clerk instance is in live mode; no identity was created');
      return;
    }
    if (issuer && instance && !issuer.includes(instance)) {
      finding(`the publishable key instance (${instance}) does not match the configured issuer (${issuer}); no identity was created`);
      return;
    }
  }
  if (issuer) step('backend-issuer', issuer);

  const emails = [
    process.env.TEST_EMAIL || `noc263-verify+${RUN_ID}@nightlamp.dev`,
    `noc263-verify+${RUN_ID}@example.com`,
  ];
  const existing = await listClerkUsers();
  let user = await createClerkUser(emails);
  if (!user) {
    const candidate = existing.find((entry) => looksLikeTestIdentity(entry.email));
    if (candidate) {
      step('clerk-user-reused', `${candidate.id} (an existing verification identity was reused)`);
      user = { id: candidate.id };
    }
  }
  if (!user) {
    finding('the Clerk test identity could not be created');
    return;
  }
  const userId = user.id;
  report.testUser = { id: userId, email: user.email_address ? user.email_address[0] && user.email_address[0].email_address : emails[0] };

  const session = await clerk('POST', '/sessions', { user_id: userId });
  if (!session.json || !session.json.id) {
    finding(`the Clerk session could not be created (HTTP ${session.status}: ${scrub(session.text)})`);
    await clerk('DELETE', `/users/${userId}`);
    return;
  }
  const sessionId = session.json.id;
  step('clerk-session-created', sessionId);

  const tokenRes = await clerk('POST', `/sessions/${sessionId}/tokens`);
  const token = tokenRes.json && tokenRes.json.jwt;
  if (!token) {
    finding(`the Clerk session token could not be minted (HTTP ${tokenRes.status}: ${scrub(tokenRes.text)})`);
    await clerk('DELETE', `/users/${userId}`);
    return;
  }
  const decoded = decodeJwt(token);
  if (decoded) {
    report.clerkToken = {
      alg: decoded.header.alg || null,
      kid: decoded.header.kid || null,
      typ: decoded.header.typ || null,
      iss: decoded.payload.iss || null,
      exp: decoded.payload.exp || null,
      nbf: decoded.payload.nbf || null,
      iat: decoded.payload.iat || null,
      version: decoded.payload.v || null,
      claimKeys: Object.keys(decoded.payload).sort(),
      hasOrgClaim: Boolean(decoded.payload.org_id || decoded.payload.orgId || decoded.payload.o),
      hasAzpClaim: Boolean(decoded.payload.azp),
      sub: decoded.payload.sub || null,
    };
    step('clerk-token-minted', `alg=${report.clerkToken.alg} kid=${report.clerkToken.kid} claims=${report.clerkToken.claimKeys.length}`);
    if (report.clerkToken.alg !== 'RS256') {
      finding(`the minted Clerk session token is ${report.clerkToken.alg}; the deployed backend verifies RS256 only`);
    }
    if (report.clerkToken.iss && issuer && report.clerkToken.iss !== issuer) {
      finding(`the minted token issuer (${report.clerkToken.iss}) does not match the configured issuer (${issuer})`);
    }
  } else {
    finding('the minted Clerk session token could not be decoded');
  }

  await probe('anonymous-events', '/api/events', { expect: 401 });
  await probe('anonymous-remediation-runs', '/api/remediation/runs', { expect: 401 });
  await probe('anonymous-health', '/api/health', { expect: 200 });

  const memberEvents = await probe('signed-in-events', '/api/events', { token, expect: 403 });
  const memberRuns = await probe('signed-in-remediation-runs', '/api/remediation/runs', { token, expect: 403 });
  const memberChecks = await probe('signed-in-check-results', '/api/check-results', { token, expect: 403 });
  const memberTeams = await probe('signed-in-teams', '/api/teams', { token, expect: 200 });
  await probe('signed-in-acknowledge-unknown-id', '/api/events/acknowledge', {
    token,
    method: 'POST',
    body: { id: 'probe-not-a-real-id' },
    expect: 404,
  });

  const signedInUserId = memberTeams.json && memberTeams.json.teams ? memberTeams.json.teams.length : null;
  step('signed-in-team-count', String(signedInUserId));

  const createTeam = await probe('signed-in-create-team', '/api/teams', {
    token,
    method: 'POST',
    body: {
      name: `Nightlamp verification ${RUN_ID}`,
      slug: `noc263-verify-${String(RUN_ID).replace(/[^0-9A-Za-z]/g, '').slice(0, 12).toLowerCase()}`,
      ownerId: userId,
    },
    expect: 200,
  });
  const createdTeamId = createTeam.json && createTeam.json.id;
  if (createdTeamId) {
    report.createdArtifacts.push({ kind: 'team', id: createdTeamId, slug: createTeam.json.slug });
    await probe('signed-in-list-teams-after-create', '/api/teams', { token, expect: 200 });
    await probe('signed-in-events-with-created-team', '/api/events', {
      token,
      extraHeaders: { 'x-nightlamp-team-id': createdTeamId },
      expect: 403,
    });
    await probe('signed-in-team-path-after-create', `/api/teams/${createdTeamId}`, { token, expect: 403 });
  }

  const eventsCount = memberEvents.json && typeof memberEvents.json.count === 'number' ? memberEvents.json.count : null;
  if (memberEvents.status === 200 && eventsCount && eventsCount > 0) {
    finding(`a signed-in identity with no membership reads ${eventsCount} unscoped rows through GET /api/events`);
  }
  if (memberEvents.status === 200) {
    finding('a signed-in identity with no membership is answered 200 on GET /api/events; the contract requires 403');
  }
  if (memberRuns.status === 200) {
    finding('a signed-in identity with no membership is answered 200 on GET /api/remediation/runs; the contract requires 403');
  }
  if (memberChecks.status === 200) {
    finding('a signed-in identity with no membership is answered 200 on GET /api/check-results; the contract requires 403');
  }
  if (createdTeamId && memberTeams.json && Array.isArray(memberTeams.json.teams) && memberTeams.json.teams.length === 0) {
    finding('a team created by the authenticated identity does not appear in GET /api/teams; the membership is not bound to the authenticated user');
  }

  await clerk('DELETE', `/users/${userId}`);
  step('clerk-test-user-deleted', userId);
}

async function main() {
  try {
    await run();
  } catch (err) {
    finding(`the verification script failed: ${scrub(err && err.message ? err.message : err)}`);
  } finally {
    report.finished = true;
    report.finishedAt = new Date().toISOString();
    try {
      fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    } catch {
      process.stdout.write('the report could not be written\n');
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
}

main();
