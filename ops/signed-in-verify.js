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

const report = {
  run: RUN_ID,
  startedAt: new Date().toISOString(),
  backendUrl: BACKEND_URL,
  identity: null,
  token: null,
  memberAccess: null,
  noMembershipAccess: null,
  probes: [],
  steps: [],
  findings: [],
  createdArtifacts: [],
  valuesIncluded: false,
  finished: false,
};

function step(name, detail) {
  report.steps.push({ name, detail: String(detail).slice(0, 300) });
}

function finding(text) {
  report.findings.push(String(text).slice(0, 400));
}

function scrub(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/sk_[A-Za-z0-9_-]+/g, 'sk_[redacted]')
    .replace(/pk_[A-Za-z0-9_-]+/g, 'pk_[redacted]')
    .slice(0, 200);
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
  const first = res.json.errors[0];
  return `${res.status} ${first.code || ''} ${first.message || first.long_message || ''}`.slice(0, 300);
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

async function listClerkUsers() {
  const res = await clerk('GET', '/users?limit=20&order_by=-created_at', null, { withVersion: true });
  const data = Array.isArray(res.json) ? res.json : (res.json && Array.isArray(res.json.data) ? res.json.data : null);
  if (!data) {
    step('clerk-user-list', `HTTP ${res.status}, the instance key could not list the users`);
    return [];
  }
  step('clerk-user-list', `HTTP ${res.status}, ${data.length} users visible to the instance key`);
  return data.map((entry) => ({
    id: entry.id,
    label: `${entry.first_name || ''} ${entry.last_name || ''}`.trim() || 'unnamed',
    email: Array.isArray(entry.email_addresses) && entry.email_addresses.length ? entry.email_addresses[0].email_address : '',
  }));
}

function looksLikeTestIdentity(entry) {
  return /(^|[\s@.+_-])(qa|test|verify|verification|nightlamp|noc|ci|bot)([\s@.+_-]|$)/i.test(`${entry.label || ''} ${entry.email || ''}`);
}

async function createClerkUser(email) {
  const bodies = [
    { email_address: email, skip_email_verification: true },
    { email_address: email },
    { email_address: email, skip_email_verification: true, first_name: 'Nightlamp', last_name: 'Verification' },
  ];
  for (const body of bodies) {
    const res = await clerk('POST', '/users', body, { withVersion: true });
    if (res.json && res.json.id) {
      step('clerk-user-created', `${res.json.id}`);
      return res.json;
    }
    step('clerk-user-create-attempt', `body=${Object.keys(body).sort().join('+')} -> ${clerkErrorSummary(res)}`);
  }
  return null;
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
  const instance = clerkInstanceFromPublishable(publishable);
  const mode = publishable.startsWith('pk_test_') ? 'test' : publishable.startsWith('pk_live_') ? 'live' : 'unknown';
  step('clerk-instance', `mode=${mode} instance=${instance || 'unresolved'}`);
  if (mode === 'live') {
    finding('the production Clerk instance is in live mode; no identity was used');
    return;
  }
  if (issuer && instance && !issuer.includes(instance)) {
    finding(`the publishable key instance (${instance}) does not match the configured issuer (${issuer}); no identity was used`);
    return;
  }
  if (issuer) step('backend-issuer', issuer);

  const existing = await listClerkUsers();
  let user = existing.find((entry) => looksLikeTestIdentity(entry)) || null;
  let createdUser = false;
  if (!user) {
    const email = `noc263-verify+${RUN_ID}@nightlamp.dev`;
    const created = await createClerkUser(email);
    if (created) {
      user = { id: created.id, label: 'Nightlamp Verification', email };
      createdUser = true;
    }
  } else {
    step('clerk-identity-selected', `${user.id} (an existing verification identity was reused, no account was created)`);
  }
  if (!user) {
    finding('no Clerk verification identity is available');
    return;
  }
  report.identity = { id: user.id, label: user.label || null, reused: !createdUser };

  const session = await clerk('POST', '/sessions', { user_id: user.id });
  if (!session.json || !session.json.id) {
    finding(`the Clerk session could not be created (${clerkErrorSummary(session)})`);
    return;
  }
  const sessionId = session.json.id;
  step('clerk-session-created', sessionId);

  const tokenRes = await clerk('POST', `/sessions/${sessionId}/tokens`);
  const token = tokenRes.json && tokenRes.json.jwt;
  if (!token) {
    finding(`the Clerk session token could not be minted (${clerkErrorSummary(tokenRes)})`);
    await clerk('DELETE', `/sessions/${sessionId}`);
    return;
  }
  const decoded = decodeJwt(token);
  if (decoded) {
    report.token = {
      alg: decoded.header.alg || null,
      kid: decoded.header.kid || null,
      iss: decoded.payload.iss || null,
      exp: decoded.payload.exp || null,
      version: decoded.payload.v || null,
      claimKeys: Object.keys(decoded.payload).sort(),
      hasOrgClaim: Boolean(decoded.payload.org_id || decoded.payload.orgId || decoded.payload.o),
      hasAzpClaim: Boolean(decoded.payload.azp),
      sub: decoded.payload.sub || null,
    };
    step('clerk-token-minted', `alg=${report.token.alg} kid=${report.token.kid} claims=${report.token.claimKeys.length}`);
    if (report.token.alg !== 'RS256') {
      finding(`the minted Clerk session token is ${report.token.alg}; the deployed backend verifies RS256 only`);
    }
    if (report.token.iss && issuer && report.token.iss !== issuer) {
      finding(`the minted token issuer (${report.token.iss}) does not match the configured issuer (${issuer})`);
    }
  } else {
    finding('the minted Clerk session token could not be decoded');
  }

  await probe('anonymous-events', '/api/events', { expect: 401 });
  await probe('anonymous-remediation-runs', '/api/remediation/runs', { expect: 401 });
  await probe('anonymous-health', '/api/health', { expect: 200 });

  const teams = await probe('signed-in-teams', '/api/teams', { token, expect: 200 });
  const teamCount = teams.json && Array.isArray(teams.json.teams) ? teams.json.teams.length : null;
  const events = await probe('signed-in-events', '/api/events', { token, expect: 403 });
  const runs = await probe('signed-in-remediation-runs', '/api/remediation/runs', { token, expect: 403 });
  const checks = await probe('signed-in-check-results', '/api/check-results', { token, expect: 403 });
  await probe('signed-in-acknowledge-unknown-id', '/api/events/acknowledge', {
    token,
    method: 'POST',
    body: { id: 'probe-not-a-real-id' },
    expect: 404,
  });

  const hasTeam = Boolean(teamCount);
  if (hasTeam) {
    report.memberAccess = {
      teamsVisible: teamCount,
      eventsStatus: events.status,
      eventsCount: events.json && typeof events.json.count === 'number' ? events.json.count : null,
      remediationRunsStatus: runs.status,
      checkResultsStatus: checks.status,
    };
  } else {
    report.memberAccess = {
      teamsVisible: teamCount,
      eventsStatus: events.status,
      eventsCount: events.json && typeof events.json.count === 'number' ? events.json.count : null,
      remediationRunsStatus: runs.status,
      checkResultsStatus: checks.status,
      note: 'the identity has no team visible through GET /api/teams, so the member case could not be exercised',
    };
  }

  report.noMembershipAccess = {
    contract: 403,
    eventsStatus: events.status,
    eventsCount: events.json && typeof events.json.count === 'number' ? events.json.count : null,
    eventsMeetsContract: events.status === 403,
    remediationRunsStatus: runs.status,
    remediationRunsMeetsContract: runs.status === 403,
    checkResultsStatus: checks.status,
    checkResultsMeetsContract: checks.status === 403,
  };

  if (events.status === 200) {
    const count = events.json && typeof events.json.count === 'number' ? events.json.count : null;
    finding(`a signed-in identity with no membership is answered 200 on GET /api/events (contract 403); it can read ${count === null ? 'an unknown number of' : count} unscoped rows`);
  }
  if (runs.status === 200) {
    finding('a signed-in identity with no membership is answered 200 on GET /api/remediation/runs (contract 403)');
  }
  if (checks.status === 200) {
    finding('a signed-in identity with no membership is answered 200 on GET /api/check-results (contract 403)');
  }
  if (events.status === 401) {
    finding('the deployed backend rejected a genuine Clerk session token with 401');
  }
  if (events.status === 500 || runs.status === 500 || checks.status === 500) {
    finding(`the deployed backend answers 500 on an authenticated read (events=${events.status} remediationRuns=${runs.status} checkResults=${checks.status}); the server-side key or the request path is broken`);
  }

  const createTeam = await probe('signed-in-create-team', '/api/teams', {
    token,
    method: 'POST',
    body: {
      name: `Nightlamp verification ${RUN_ID}`,
      slug: `noc263-verify-${String(RUN_ID).replace(/[^0-9A-Za-z]/g, '').slice(0, 12).toLowerCase()}`,
      ownerId: user.id,
    },
    expect: 200,
  });
  const createdTeamId = createTeam.json && createTeam.json.id;
  if (createdTeamId) {
    report.createdArtifacts.push({ kind: 'team', id: createdTeamId, slug: createTeam.json.slug });
    const teamsAfter = await probe('signed-in-teams-after-create', '/api/teams', { token, expect: 200 });
    const afterCount = teamsAfter.json && Array.isArray(teamsAfter.json.teams) ? teamsAfter.json.teams.length : null;
    if (afterCount === 0) {
      finding('a team created by the authenticated identity does not appear in GET /api/teams: the membership is not bound to the authenticated user');
    }
    await probe('signed-in-events-with-created-team', '/api/events', {
      token,
      extraHeaders: { 'x-nightlamp-team-id': createdTeamId },
      expect: 403,
    });
    await probe('signed-in-team-path-after-create', `/api/teams/${createdTeamId}`, { token, expect: 403 });
  }

  await clerk('DELETE', `/sessions/${sessionId}`);
  step('clerk-session-revoked', sessionId);
  if (createdUser) {
    await clerk('DELETE', `/users/${user.id}`);
    step('clerk-user-deleted', user.id);
  }
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
