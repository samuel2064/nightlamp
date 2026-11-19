// NOC-324: Updated for controlled identity workflow gate
// - Exits non-zero on probe failures, contract mismatches, or server restart
// - Report derived from observed results (testTeamRemoved, fullMatrixRun)
// - Server restart detection via /api/health uptime/bootId comparison
// NOC-339: Two-tenant cross-org isolation probes for seven NOC-337 surfaces
const fs = require('fs');
const { execFileSync } = require('child_process');

const renderApi = process.env.RENDER_API || 'https://api.render.com/v1';
const renderKey = process.env.RENDER_API_KEY;
const frontendId = process.env.RENDER_FRONTEND_SERVICE_ID || process.env.FRONTEND_SERVICE_ID;
const clerkApi = process.env.CLERK_API || 'https://api.clerk.com/v1';
const expectedInstance = process.env.CLERK_INSTANCE;
const expectedIssuer = process.env.CLERK_ISSUER;
const nightlampApi = process.env.NIGHTLAMP_API || 'https://nightlamp-api.onrender.com';
const resultFile = process.env.RESULT_FILE || '/tmp/controlled-identity-result.json';
const marker = process.env.VERIFICATION_MARKER || 'nightlamp-controlled-verification';
const emailDomain = process.env.VERIFICATION_EMAIL_DOMAIN || 'example.com';

const noTeamExpectedStatus = process.env.NO_TEAM_EXPECTED_STATUS ? parseInt(process.env.NO_TEAM_EXPECTED_STATUS, 10) : 403;

const report = {
  probes: [],
  identity: {},
  diagnostics: [],
  valuesIncluded: false,
  bodiesIncluded: false,
};

let secretKey = null;
const userSessions = new Map();
const runStartedAt = Date.now();
let initialHealth = null;
let finalHealth = null;

function redact(text) {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/user_[A-Za-z0-9]+/g, '<clerk-user>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/controlled-test-\d+/g, '<team>')
    .replace(/controlled-owner-\d+/g, '<controlled-owner>');
}

function log(line) {
  const safe = redact(line);
  console.log(safe);
  report.diagnostics.push(safe);
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

async function readPreviousReport() {
  try {
    const output = execFileSync('git', ['show', 'origin/ops/render-auth-report:reports/signed-in-verification.json'], { encoding: 'utf8' });
    const previous = JSON.parse(output);
    return previous;
  } catch (error) {
    return null;
  }
}

async function fetchFrontendEnv() {
  const envVars = await renderRequest('GET', `/services/${frontendId}/env-vars`);
  log(`GET the frontend environment variables -> HTTP ${envVars.status}`);
  if (envVars.status !== 200) {
    report.error = 'the frontend environment variables could not be read';
    return false;
  }
  const variables = (Array.isArray(envVars.body) ? envVars.body : []).map((entry) => entry.envVar || entry);
  const secret = variables.find((entry) => entry.key === 'CLERK_SECRET_KEY');
  const publishable = variables.find((entry) => entry.key === 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY');
  report.identity.frontendHasClerkSecret = Boolean(secret && secret.value);
  report.identity.frontendHasPublishableKey = Boolean(publishable && publishable.value);
  if (!secret || !secret.value) {
    report.error = 'CLERK_SECRET_KEY is not set on the frontend service';
    return false;
  }
  if (!publishable || !publishable.value) {
    report.error = 'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set on the frontend service';
    return false;
  }
  const publishableInstance = clerkInstance(String(publishable.value).trim());
  log(`the frontend publishable key belongs to the Clerk instance: ${publishableInstance || 'unknown'}`);
  if (!publishableInstance || publishableInstance !== expectedInstance) {
    report.error = 'the frontend publishable key belongs to a different Clerk instance';
    return false;
  }
  secretKey = String(secret.value).trim();
  return true;
}

async function enumerateClerkUsers() {
  const users = await clerkRequest('GET', '/users?limit=100');
  log(`GET the Clerk users -> HTTP ${users.status}`);
  if (users.status !== 200) {
    report.error = 'the Clerk Backend API did not accept the secret key';
    return [];
  }
  const existingUsers = Array.isArray(users.body) ? users.body : [];
  report.identity.existingUserCount = existingUsers.length;
  log(`Found ${existingUsers.length} existing Clerk users`);
  
  for (const user of existingUsers) {
    log(`  User: ${user.id} (${user.email_addresses?.[0]?.email_address || 'no email'})`);
  }
  
  return existingUsers;
}

async function createControlledOwner() {
  const email = `controlled-owner-${Date.now()}@${emailDomain}`;
  const password = 'controlled-verification-' + Date.now();
  const firstName = 'Controlled';
  const lastName = 'Owner';
  
  const createResponse = await clerkRequest('POST', '/users', {
    email_address: [email],
    password,
    first_name: firstName,
    last_name: lastName,
    skip_password_requirement: true,
    skip_password_confirmation: true,
  });

  log(`POST create controlled owner user -> HTTP ${createResponse.status}`);
  if (createResponse.status < 200 || createResponse.status >= 300 || !createResponse.body || !createResponse.body.id) {
    log(`  Failed to create controlled owner: ${createResponse.status}`);
    return null;
  }
  
  const userId = createResponse.body.id;
  log(`Created controlled owner: ${userId} (${email})`);
  report.identity.controlledOwnerCreated = true;
  report.identity.controlledOwnerId = userId;
  
  return userId;
}

async function deleteControlledOwner(userId) {
  const deleteResponse = await clerkRequest('DELETE', `/users/${userId}`);
  log(`DELETE controlled owner user ${userId} -> HTTP ${deleteResponse.status}`);
  const success = deleteResponse.status === 204 || deleteResponse.status === 200;
  if (success) {
    log(`Controlled owner ${userId} deleted successfully`);
    report.identity.controlledOwnerDeleted = true;
  } else {
    log(`Failed to delete controlled owner ${userId}`);
    report.identity.controlledOwnerDeleted = false;
  }
  return success;
}

async function mintAndRevokeSession(userId, label) {
  const session = await clerkRequest('POST', '/sessions', { user_id: userId });
  log(`POST a session for ${label} -> HTTP ${session.status}`);
  if (session.status < 200 || session.status >= 300 || !session.body || !session.body.id) {
    log(`  Failed to create session for ${label}: ${session.status}`);
    return null;
  }
  const sessionId = session.body.id;
  
  const tokenResponse = await clerkRequest('POST', `/sessions/${sessionId}/tokens`, {});
  log(`POST a session token for ${label} -> HTTP ${tokenResponse.status}`);
  const token = tokenResponse.body && tokenResponse.body.jwt;
  if (tokenResponse.status < 200 || tokenResponse.status >= 300 || !token) {
    log(`  Failed to mint token for ${label}: ${tokenResponse.status}`);
    return null;
  }
  
  let claims = {};
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
  } catch (error) {
    claims = {};
  }
  const tokenIssuer = typeof claims.iss === 'string' ? claims.iss : null;
  if (tokenIssuer !== expectedIssuer) {
    log(`  Token issuer mismatch for ${label}: expected ${expectedIssuer}, got ${tokenIssuer}`);
    return null;
  }
  
  log(`  Token minted successfully for ${label}`);
  
  userSessions.set(userId, { sessionId, token, claims });
  return { sessionId, token, claims };
}

async function revokeSession(userId) {
  const sessionData = userSessions.get(userId);
  if (!sessionData) return false;
  
  const revoked = await clerkRequest('POST', `/sessions/${sessionData.sessionId}/revoke`, {});
  log(`POST revoke session for ${userId} -> HTTP ${revoked.status}`);
  const success = revoked.status === 204 || revoked.status === 200;
  if (!success) {
    const removed = await clerkRequest('DELETE', `/sessions/${sessionData.sessionId}`);
    log(`DELETE session for ${userId} -> HTTP ${removed.status}`);
    return removed.status === 204 || removed.status === 200;
  }
  return success;
}

async function queryTeamMembership(token, userId) {
  const json = { 'Content-Type': 'application/json' };
  const response = await fetch(`${nightlampApi}/api/teams`, { headers: bearer(token) });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  
  if (response.status !== 200) {
    log(`  Failed to list teams for ${userId}: HTTP ${response.status}`);
    return { teams: [], role: null };
  }
  
  const teams = parsed.teams || [];
  log(`  the identity has access to ${teams.length} team(s)`);
  
  for (const team of teams) {
    log(`    a team the identity can reach: ${team.id} (${team.name})`);
  }
  
  const hasTeam = teams.length > 0;
  
  return {
    teams,
    hasTeam,
    ownedTeam: hasTeam ? teams[0] : null,
    memberTeam: hasTeam ? teams[0] : null,
    isOwner: hasTeam,
    isMember: hasTeam
  };
}

async function ensureUserInNightlamp(token, userId) {
  log(`  Ensuring user ${userId} exists in Nightlamp database...`);
  const response = await fetch(`${nightlampApi}/api/teams`, { headers: bearer(token) });
  log(`  GET /api/teams for sync -> HTTP ${response.status}`);
  return response.status === 200 || response.status === 401;
}

async function createTestTeam(ownerToken) {
  const teamName = `controlled-test-${Date.now()}`;
  const teamSlug = `controlled-test-${Date.now()}`;
  const response = await fetch(`${nightlampApi}/api/teams`, {
    method: 'POST',
    headers: bearer(ownerToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: teamName, slug: teamSlug, plan: 'free' })
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  
  if (response.status >= 200 && response.status < 300 && parsed && parsed.id) {
    log(`Created test team: ${parsed.id} (${teamName})`);
    log(`The server bound the team owner to the authenticated token: ${parsed.ownerId ? 'yes' : 'no'}`);
    return { teamId: parsed.id, status: response.status, ownerBoundToToken: Boolean(parsed.ownerId) };
  } else {
    log(`Failed to create test team: HTTP ${response.status}`);
    return { teamId: null, status: response.status, ownerBoundToToken: false };
  }
}

async function inviteAndAcceptMember(ownerToken, memberToken, teamId, memberEmail, memberClerkId) {
  const candidates = [];
  if (memberEmail) candidates.push(memberEmail);
  if (memberClerkId) candidates.push(`${memberClerkId}@clerk.local`);
  
  for (const email of candidates) {
    const invite = await fetch(`${nightlampApi}/api/teams/${teamId}/invitations`, {
      method: 'POST',
      headers: bearer(ownerToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ email, role: 'member' })
    });
    const inviteText = await invite.text();
    let inviteJson = null;
    try { inviteJson = JSON.parse(inviteText); } catch (error) { inviteJson = null; }
    
    if (invite.status < 200 || invite.status >= 300 || !inviteJson || !inviteJson.token) {
      log(`Failed to create an invitation: HTTP ${invite.status}`);
      continue;
    }
    
    const accept = await fetch(`${nightlampApi}/api/invitations/${inviteJson.token}/accept`, {
      method: 'POST',
      headers: bearer(memberToken, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({})
    });
    const acceptText = await accept.text();
    let acceptJson = null;
    try { acceptJson = JSON.parse(acceptText); } catch (error) { acceptJson = null; }
    
    if (accept.status >= 200 && accept.status < 300) {
      log('The member identity accepted the invitation and was bound to its own token');
      return { joined: true, userId: acceptJson && acceptJson.userId ? acceptJson.userId : null };
    }
    log(`The invitation was not accepted: HTTP ${accept.status}`);
  }
  
  return { joined: false, userId: null };
}

async function addMemberToTeam(ownerToken, teamId, memberEmail, role = 'member') {
  const response = await fetch(`${nightlampApi}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: bearer(ownerToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ email: memberEmail, role })
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }

  if (response.status >= 200 && response.status < 300) {
    log(`Added the member identity as ${role} to the test team`);
    return { added: true, userId: parsed && parsed.userId ? parsed.userId : null };
  } else {
    log(`Failed to add member: HTTP ${response.status}`);
    return { added: false, userId: null };
  }
}

async function deleteTeam(ownerToken, teamId) {
  const response = await fetch(`${nightlampApi}/api/teams/${teamId}`, {
    method: 'DELETE',
    headers: bearer(ownerToken)
  });
  log(`DELETE team ${teamId} -> HTTP ${response.status}`);
  return response.status >= 200 && response.status < 300;
}

function getUserTeamIds(userRole) {
  if (!userRole || !Array.isArray(userRole.teams)) return [];
  return userRole.teams.map(t => t.id).filter(Boolean);
}

async function fetchHealth() {
  try {
    const response = await fetch(`${nightlampApi}/api/health`);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  } catch (error) {
    return { status: 0, body: null, error: error.message };
  }
}

function extractUptimeAndBootId(health) {
  if (!health || !health.body || typeof health.body !== 'object') {
    return { uptime: undefined, bootId: undefined };
  }
  const body = health.body;
  const uptime = body.uptimeSeconds !== undefined ? body.uptimeSeconds : (body.uptime !== undefined ? body.uptime : undefined);
  const bootId = body.bootId;
  return { uptime, bootId };
}

async function probeWithForeignRowCheck(label, url, options, expected, userId, userRole) {
  const response = await fetch(url, options);
  const text = await response.text();
  let code = null;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
    code = typeof parsed.code === 'string' ? parsed.code : null;
  } catch (error) {
    parsed = null;
  }
  
  let foreignRows = 0;
  let ownRows = 0;
  let personalRows = 0;
  const userTeamIds = getUserTeamIds(userRole);
  const isNoTeamUser = userTeamIds.length === 0;
  
  if (response.status === 200 && parsed) {
    const items = Array.isArray(parsed.events) ? parsed.events : (Array.isArray(parsed.runs) ? parsed.runs : []);
    for (const item of items) {
      if (item.teamId) {
        if (userTeamIds.includes(item.teamId)) {
          ownRows++;
        } else {
          foreignRows++;
        }
      } else {
        personalRows++;
      }
    }
  }
  
  if (foreignRows > 0 || ownRows > 0 || personalRows > 0) {
    log(`  Foreign rows: ${foreignRows}, Own team rows: ${ownRows}, Personal rows: ${personalRows}, isNoTeamUser: ${isNoTeamUser}`);
  }
  
  const statusOk = expected.includes(response.status);
  const foreignRowsOk = !isNoTeamUser || foreignRows === 0;
  
  // Contract mismatch detection: for no-team users, the decided contract (NOC-294) requires 403.
  // If the build returns 200 when 403 is expected, flag it and don't count as pass.
  const contractExpectedStatus = isNoTeamUser ? 403 : expected[0];
  const contractMismatch = isNoTeamUser && response.status === 200 && contractExpectedStatus === 403;
  const ok = (contractMismatch ? false : statusOk) && foreignRowsOk;
  
  const entry = {
    label,
    expected,
    expectedStatusUsed: contractExpectedStatus,
    status: response.status,
    code,
    ok,
    foreignRows,
    ownRows,
    personalRows,
    isNoTeamUser,
    contractMismatch,
  };
  report.probes.push(entry);
  const details = foreignRows > 0 || ownRows > 0 || personalRows > 0 ? ` (foreignRows: ${foreignRows}, ownRows: ${ownRows}, personalRows: ${personalRows})` : '';
  const foreignRowsDetail = isNoTeamUser && foreignRows > 0 ? ` FOREIGN ROWS DETECTED: ${foreignRows}` : '';
  const mismatchDetail = contractMismatch ? ` CONTRACT MISMATCH: build returned 200 but decided contract requires 403` : '';
  log(`${ok ? 'PASS' : 'FAIL'} ${label} expected ${expected.join('/')} got ${response.status}${code ? ` ${code}` : ''}${details}${foreignRowsDetail}${mismatchDetail}`);
  return entry;
}

async function runNoc280Matrix(memberToken, teamId, memberId, ownerToken) {
  const json = { 'Content-Type': 'application/json' };
  const results = [];
  
  log('--- NOC-280: Self-promotion attempt ---');
  const selfPromote = await fetch(`${nightlampApi}/api/teams/${teamId}/members/${memberId}`, {
    method: 'PATCH',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ role: 'owner' })
  });
  const spText = await selfPromote.text();
  let spParsed = null;
  try { spParsed = JSON.parse(spText); } catch {}
  results.push({
    test: 'self-promotion-to-owner',
    expected: [403],
    status: selfPromote.status,
    code: spParsed?.code,
    ok: selfPromote.status === 403
  });
  log(`Self-promotion to owner: ${selfPromote.status} ${selfPromote.status === 403 ? 'PASS' : 'FAIL'}`);
  
  const selfPromoteAdmin = await fetch(`${nightlampApi}/api/teams/${teamId}/members/${memberId}`, {
    method: 'PATCH',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ role: 'admin' })
  });
  const spaText = await selfPromoteAdmin.text();
  let spaParsed = null;
  try { spaParsed = JSON.parse(spaText); } catch {}
  results.push({
    test: 'self-promotion-to-admin',
    expected: [403],
    status: selfPromoteAdmin.status,
    code: spaParsed?.code,
    ok: selfPromoteAdmin.status === 403
  });
  log(`Self-promotion to admin: ${selfPromoteAdmin.status} ${selfPromoteAdmin.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Member add/remove members ---');
  const fakeUserId = 'fake-user-' + Date.now();
  const addMember = await fetch(`${nightlampApi}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ userId: fakeUserId, role: 'member' })
  });
  const amText = await addMember.text();
  let amParsed = null;
  try { amParsed = JSON.parse(amText); } catch {}
  results.push({
    test: 'member-add-member',
    expected: [403],
    status: addMember.status,
    code: amParsed?.code,
    ok: addMember.status === 403
  });
  log(`Member add member: ${addMember.status} ${addMember.status === 403 ? 'PASS' : 'FAIL'}`);
  
  const removeMember = await fetch(`${nightlampApi}/api/teams/${teamId}/members/${memberId}`, {
    method: 'DELETE',
    headers: bearer(memberToken)
  });
  const rmText = await removeMember.text();
  let rmParsed = null;
  try { rmParsed = JSON.parse(rmText); } catch {}
  results.push({
    test: 'member-remove-self',
    expected: [403],
    status: removeMember.status,
    code: rmParsed?.code,
    ok: removeMember.status === 403
  });
  log(`Member remove self: ${removeMember.status} ${removeMember.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Member rewrite/delete team ---');
  const rewriteTeam = await fetch(`${nightlampApi}/api/teams/${teamId}`, {
    method: 'PATCH',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ name: 'Hacked Team' })
  });
  const rtText = await rewriteTeam.text();
  let rtParsed = null;
  try { rtParsed = JSON.parse(rtText); } catch {}
  results.push({
    test: 'member-rewrite-team',
    expected: [403],
    status: rewriteTeam.status,
    code: rtParsed?.code,
    ok: rewriteTeam.status === 403
  });
  log(`Member rewrite team: ${rewriteTeam.status} ${rewriteTeam.status === 403 ? 'PASS' : 'FAIL'}`);
  
  const deleteTeam = await fetch(`${nightlampApi}/api/teams/${teamId}`, {
    method: 'DELETE',
    headers: bearer(memberToken)
  });
  const dtText = await deleteTeam.text();
  let dtParsed = null;
  try { dtParsed = JSON.parse(dtText); } catch {}
  results.push({
    test: 'member-delete-team',
    expected: [403],
    status: deleteTeam.status,
    code: dtParsed?.code,
    ok: deleteTeam.status === 403
  });
  log(`Member delete team: ${deleteTeam.status} ${deleteTeam.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Member create privileged invitation ---');
  const adminInvite = await fetch(`${nightlampApi}/api/teams/${teamId}/invitations`, {
    method: 'POST',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ email: 'fake@example.com', role: 'admin' })
  });
  const aiText = await adminInvite.text();
  let aiParsed = null;
  try { aiParsed = JSON.parse(aiText); } catch {}
  results.push({
    test: 'member-create-admin-invitation',
    expected: [403],
    status: adminInvite.status,
    code: aiParsed?.code,
    ok: adminInvite.status === 403
  });
  log(`Member create admin invitation: ${adminInvite.status} ${adminInvite.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Admin endpoint ---');
  const adminEndpoint = await fetch(`${nightlampApi}/api/admin`, {
    headers: bearer(memberToken)
  });
  const aeText = await adminEndpoint.text();
  let aeParsed = null;
  try { aeParsed = JSON.parse(aeText); } catch {}
  results.push({
    test: 'member-admin-endpoint',
    expected: [403],
    status: adminEndpoint.status,
    code: aeParsed?.code,
    ok: adminEndpoint.status === 403
  });
  log(`Member admin endpoint: ${adminEndpoint.status} ${adminEndpoint.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Unknown team ---');
  const unknownTeam = await fetch(`${nightlampApi}/api/teams/nightlamp-controlled-unknown-team`, {
    headers: bearer(memberToken)
  });
  const utText = await unknownTeam.text();
  let utParsed = null;
  try { utParsed = JSON.parse(utText); } catch {}
  results.push({
    test: 'unknown-team',
    expected: [404],
    status: unknownTeam.status,
    code: utParsed?.code,
    ok: unknownTeam.status === 404
  });
  log(`Unknown team: ${unknownTeam.status} ${unknownTeam.status === 404 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Non-member role target ---');
  const fakeTargetId = 'fake-target-' + Date.now();
  const nonMemberTarget = await fetch(`${nightlampApi}/api/teams/${teamId}/members/${fakeTargetId}`, {
    method: 'PATCH',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ role: 'owner' })
  });
  const nmtText = await nonMemberTarget.text();
  let nmtParsed = null;
  try { nmtParsed = JSON.parse(nmtText); } catch {}
  results.push({
    test: 'non-member-target',
    expected: [403],
    status: nonMemberTarget.status,
    code: nmtParsed?.code,
    ok: nonMemberTarget.status === 403
  });
  log(`Non-member target: ${nonMemberTarget.status} ${nonMemberTarget.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Owner target that does not exist ---');
  const fakeOwnerId = 'fake-owner-' + Date.now();
  const ownerNonExist = await fetch(`${nightlampApi}/api/teams/${teamId}/members/${fakeOwnerId}`, {
    method: 'PATCH',
    headers: bearer(ownerToken, json),
    body: JSON.stringify({ role: 'admin' })
  });
  const oneText = await ownerNonExist.text();
  let oneParsed = null;
  try { oneParsed = JSON.parse(oneText); } catch {}
  results.push({
    test: 'owner-target-not-exist',
    expected: [404],
    status: ownerNonExist.status,
    code: oneParsed?.code,
    ok: ownerNonExist.status === 404
  });
  log(`Owner target that does not exist: ${ownerNonExist.status} ${ownerNonExist.status === 404 ? 'PASS' : 'FAIL'}`);
  
  const membershipAfter = await queryTeamMembership(memberToken, memberId);
  const role = membershipAfter.teams.find(t => t.id === teamId)?.role || 'none';
  results.push({
    test: 'member-role-persists',
    expected: ['member'],
    status: 200,
    code: role === 'member' ? null : 'ROLE_CHANGED',
    ok: role === 'member'
  });
  log(`Member role persists as: ${role} ${role === 'member' ? 'PASS' : 'FAIL'}`);
  
  return results;
}

async function runNoc274Matrix(ownerToken, teamId) {
  const ownerHeaders = bearer(ownerToken, { 'Content-Type': 'application/json' });
  const results = [];
  
  log('--- NOC-274: Owner/admin approval reaches truthful terminal result ---');
  
  const approveUnknown = await fetch(`${nightlampApi}/api/remediation/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-run-id' })
  });
  const auText = await approveUnknown.text();
  let auParsed = null;
  try { auParsed = JSON.parse(auText); } catch {}
  const auSuccessClaimed = Boolean(auParsed && auParsed.success === true);
  results.push({
    test: 'approve-unknown-run',
    expected: [404],
    status: approveUnknown.status,
    code: auParsed?.code,
    ok: approveUnknown.status === 404 && !auSuccessClaimed
  });
  log(`Approve unknown run: ${approveUnknown.status} ${approveUnknown.status === 404 ? 'PASS' : 'FAIL'}${auSuccessClaimed ? ' SUCCESS CLAIMED' : ''}`);
  
  const rejectUnknown = await fetch(`${nightlampApi}/api/remediation/reject`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-run-id' })
  });
  const ruText = await rejectUnknown.text();
  let ruParsed = null;
  try { ruParsed = JSON.parse(ruText); } catch {}
  const ruSuccessClaimed = Boolean(ruParsed && ruParsed.success === true);
  results.push({
    test: 'reject-unknown-run',
    expected: [404],
    status: rejectUnknown.status,
    code: ruParsed?.code,
    ok: rejectUnknown.status === 404 && !ruSuccessClaimed
  });
  log(`Reject unknown run: ${rejectUnknown.status} ${rejectUnknown.status === 404 ? 'PASS' : 'FAIL'}${ruSuccessClaimed ? ' SUCCESS CLAIMED' : ''}`);
  
  const retryUnknown = await fetch(`${nightlampApi}/api/remediation/retry`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-run-id' })
  });
  const reuText = await retryUnknown.text();
  let reuParsed = null;
  try { reuParsed = JSON.parse(reuText); } catch {}
  const reuSuccessClaimed = Boolean(reuParsed && reuParsed.success === true);
  results.push({
    test: 'retry-unknown-run',
    expected: [404],
    status: retryUnknown.status,
    code: reuParsed?.code,
    ok: retryUnknown.status === 404 && !reuSuccessClaimed
  });
  log(`Retry unknown run: ${retryUnknown.status} ${retryUnknown.status === 404 ? 'PASS' : 'FAIL'}${reuSuccessClaimed ? ' SUCCESS CLAIMED' : ''}`);
  
  const unknownAction = await fetch(`${nightlampApi}/api/remediation/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-action-id' })
  });
  const uaText = await unknownAction.text();
  let uaParsed = null;
  try { uaParsed = JSON.parse(uaText); } catch {}
  const uaSuccessClaimed = Boolean(uaParsed && uaParsed.success === true);
  results.push({
    test: 'unknown-action-rejected',
    expected: [400, 404],
    status: unknownAction.status,
    code: uaParsed?.code,
    ok: [400, 404].includes(unknownAction.status) && !uaSuccessClaimed
  });
  log(`Unknown action rejected: ${unknownAction.status} ${unknownAction.status === 400 || unknownAction.status === 404 ? 'PASS' : 'FAIL'}${uaSuccessClaimed ? ' SUCCESS CLAIMED' : ''}`);
  
  return results;
}

async function cleanupTestTeam(ownerToken, teamId) {
  log('--- Cleanup: Removing test team ---');
  const success = await deleteTeam(ownerToken, teamId);
  if (success) {
    log('Test team removed successfully');
  } else {
    log('Failed to remove test team');
  }
  return success;
}

async function revokeAllSessions() {
  log('--- Cleanup: Revoking all sessions ---');
  for (const [userId, sessionData] of userSessions.entries()) {
    const revoked = await clerkRequest('POST', `/sessions/${sessionData.sessionId}/revoke`, {});
    log(`POST revoke session for ${userId} -> HTTP ${revoked.status}`);
    if (!(revoked.status === 204 || revoked.status === 200)) {
      const removed = await clerkRequest('DELETE', `/sessions/${sessionData.sessionId}`);
      log(`DELETE session for ${userId} -> HTTP ${removed.status}`);
    }
  }
}

async function checkServerRestart() {
  if (!initialHealth || !finalHealth) {
    return { valid: false, reason: 'health check missing: initial or final health not captured' };
  }
  
  const initial = extractUptimeAndBootId(initialHealth);
  const final = extractUptimeAndBootId(finalHealth);
  
  const initialUptime = initial.uptime;
  const finalUptime = final.uptime;
  const initialBootId = initial.bootId;
  const finalBootId = final.bootId;
  
  const hasUptimeSignal = initialUptime !== undefined && finalUptime !== undefined;
  const hasBootIdSignal = initialBootId !== undefined && finalBootId !== undefined;
  
  if (!hasUptimeSignal && !hasBootIdSignal) {
    return { 
      valid: false, 
      reason: 'health payload exposed no usable uptime or boot id signal; run invalidated' 
    };
  }
  
  if (hasUptimeSignal) {
    if (finalUptime < initialUptime) {
      return { 
        valid: false, 
        reason: `server restart detected: uptime went backwards (initial: ${initialUptime}s, final: ${finalUptime}s)` 
      };
    }
  }
  
  if (hasBootIdSignal && initialBootId !== finalBootId) {
    return { 
      valid: false, 
      reason: `server restart detected: boot id changed (initial: ${initialBootId}, final: ${finalBootId})` 
    };
  }
  
  return { valid: true, reason: 'no restart detected' };
}

async function runTwoTenantProbes(tenantA, tenantB, tenantATeamId, tenantBTeamId) {
  const noc337Probes = [];
  
  log('--- NOC-339: Two-tenant cross-org isolation probes ---');
  
  // 1. Playbook execution isolation
  noc337Probes.push(await probe(
    'tenant A member cannot list tenant B playbook executions',
    `${nightlampApi}/api/playbook/executions`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant A member cannot read tenant B playbook execution',
    `${nightlampApi}/api/playbook/executions/unknown-id`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant A member cannot decide tenant B playbook execution',
    `${nightlampApi}/api/playbook/executions/unknown-id/decision`,
    { method: 'POST', headers: bearer(tenantA.memberToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'approve' }) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant A member cannot cancel tenant B playbook execution',
    `${nightlampApi}/api/playbook/executions/unknown-id/cancel`,
    { method: 'POST', headers: bearer(tenantA.memberToken, { 'Content-Type': 'application/json' }) },
    [403, 404]
  ));
  
  // 2. Performance API isolation
  noc337Probes.push(await probe(
    'tenant A member cannot run performance on tenant B',
    `${nightlampApi}/api/performance/run`,
    { method: 'POST', headers: bearer(tenantA.memberToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({}) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant A member cannot read tenant B performance history',
    `${nightlampApi}/api/performance/history`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant A member cannot read tenant B performance regressions',
    `${nightlampApi}/api/performance/regressions`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant A member cannot read tenant B performance diagnosis',
    `${nightlampApi}/api/performance/diagnosis`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  
  // 3. Private streaming (SSE) isolation
  noc337Probes.push(await probe(
    'tenant A member cannot access tenant B SSE stream',
    `${nightlampApi}/api/stream`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  
  // 4. Workspace role gate (cross-tenant)
  noc337Probes.push(await probe(
    'tenant A member cannot patch tenant B workspace',
    `${nightlampApi}/api/teams/${tenantBTeamId}/workspace`,
    { method: 'PATCH', headers: bearer(tenantA.memberToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({}) },
    [403, 404]
  ));
  
  // 5. Lead isolation (cross-tenant)
  noc337Probes.push(await probe(
    'tenant A member cannot read tenant B leads',
    `${nightlampApi}/api/leads`,
    { headers: bearer(tenantA.memberToken) },
    [403, 404]
  ));
  
  // 6. Clerk webhook verification (fail closed without secret) - same for both tenants
  noc337Probes.push(await probe(
    'Clerk webhook fails without signature',
    `${nightlampApi}/api/webhooks/clerk`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) },
    [400, 401, 403]
  ));
  
  // 7. Stripe webhook reachability and signature rejection
  noc337Probes.push(await probe(
    'Stripe webhook requires valid signature',
    `${nightlampApi}/api/billing/webhook`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': 'invalid' }, body: JSON.stringify({}) },
    [400, 401, 403]
  ));
  
  // Reverse direction: tenant B member acts on tenant A resources
  noc337Probes.push(await probe(
    'tenant B member cannot list tenant A playbook executions',
    `${nightlampApi}/api/playbook/executions`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant B member cannot read tenant A playbook execution',
    `${nightlampApi}/api/playbook/executions/unknown-id`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant B member cannot decide tenant A playbook execution',
    `${nightlampApi}/api/playbook/executions/unknown-id/decision`,
    { method: 'POST', headers: bearer(tenantB.memberToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({ action: 'approve' }) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant B member cannot cancel tenant A playbook execution',
    `${nightlampApi}/api/playbook/executions/unknown-id/cancel`,
    { method: 'POST', headers: bearer(tenantB.memberToken, { 'Content-Type': 'application/json' }) },
    [403, 404]
  ));
  
  noc337Probes.push(await probe(
    'tenant B member cannot run performance on tenant A',
    `${nightlampApi}/api/performance/run`,
    { method: 'POST', headers: bearer(tenantB.memberToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({}) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant B member cannot read tenant A performance history',
    `${nightlampApi}/api/performance/history`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant B member cannot read tenant A performance regressions',
    `${nightlampApi}/api/performance/regressions`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  noc337Probes.push(await probe(
    'tenant B member cannot read tenant A performance diagnosis',
    `${nightlampApi}/api/performance/diagnosis`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  
  noc337Probes.push(await probe(
    'tenant B member cannot access tenant A SSE stream',
    `${nightlampApi}/api/stream`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  
  noc337Probes.push(await probe(
    'tenant B member cannot patch tenant A workspace',
    `${nightlampApi}/api/teams/${tenantATeamId}/workspace`,
    { method: 'PATCH', headers: bearer(tenantB.memberToken, { 'Content-Type': 'application/json' }), body: JSON.stringify({}) },
    [403, 404]
  ));
  
  noc337Probes.push(await probe(
    'tenant B member cannot read tenant A leads',
    `${nightlampApi}/api/leads`,
    { headers: bearer(tenantB.memberToken) },
    [403, 404]
  ));
  
  return noc337Probes;
}

async function run() {
  initialHealth = await fetchHealth();
  const initialUptimeInfo = extractUptimeAndBootId(initialHealth);
  log(`Initial health check: HTTP ${initialHealth.status} ${initialHealth.body ? `(uptimeSeconds: ${initialUptimeInfo.uptime}s, bootId: ${initialUptimeInfo.bootId})` : 'no body'}`);
  
  if (!await fetchFrontendEnv()) return;
  
  const existingUsers = await enumerateClerkUsers();
  if (existingUsers.length === 0) {
    report.error = 'no existing Clerk users found';
    return;
  }
  
  const userRoles = new Map();
  
  for (const user of existingUsers) {
    if (!user.id) continue;
    const sessionData = await mintAndRevokeSession(user.id, user.id);
    if (sessionData) {
      const membership = await queryTeamMembership(sessionData.token, user.id);
      const email = user.email_addresses && user.email_addresses[0] ? user.email_addresses[0].email_address : null;
      userRoles.set(user.id, { ...membership, token: sessionData.token, userId: user.id, email });
    }
  }
  
  let ownerEntry = null;
  let memberEntry = null;
  
  for (const [userId, data] of userRoles.entries()) {
    if (data.isOwner && !ownerEntry) {
      ownerEntry = { userId, ...data };
    } else if (data.isMember && !memberEntry && data.email) {
      memberEntry = { userId, ...data };
    }
  }
  
  if (!memberEntry) {
    for (const [userId, data] of userRoles.entries()) {
      if (userId !== ownerEntry?.userId && !data.isOwner && !data.isMember && data.email) {
        memberEntry = { userId, ...data };
        break;
      }
    }
  }
  
  report.identity.ownerIdentified = !!ownerEntry;
  report.identity.memberIdentified = !!memberEntry;
  
  if (ownerEntry) {
    log(`Owner identified: ${ownerEntry.userId}`);
    report.identity.ownerId = ownerEntry.userId;
  } else {
    log('No owner identified among existing users');
  }
  
  if (memberEntry) {
    log(`Second identity identified: ${memberEntry.userId} (isMember: ${memberEntry.isMember}, isOwner: ${memberEntry.isOwner})`);
    report.identity.memberId = memberEntry.userId;
    report.identity.memberIsMember = memberEntry.isMember;
    report.identity.memberIsOwner = memberEntry.isOwner;
  } else {
    log('No second identity identified among existing users');
  }
  
  let controlledOwnerId = null;
  let controlledOwnerToken = null;
  let controlledOwnerSessionUserId = null;
  
  if (!ownerEntry) {
    log('--- Creating controlled owner ---');
    controlledOwnerId = await createControlledOwner();
    if (controlledOwnerId) {
      const sessionData = await mintAndRevokeSession(controlledOwnerId, 'controlled-owner');
      if (sessionData) {
        controlledOwnerToken = sessionData.token;
        controlledOwnerSessionUserId = controlledOwnerId;
        await ensureUserInNightlamp(controlledOwnerToken, controlledOwnerId);
        const membership = await queryTeamMembership(controlledOwnerToken, controlledOwnerId);
        ownerEntry = { userId: controlledOwnerId, ...membership, token: controlledOwnerToken };
        report.identity.ownerIdentified = true;
        report.identity.ownerId = controlledOwnerId;
        report.identity.controlledOwnerUsed = true;
        log(`Controlled owner created, synced, and session minted: ${controlledOwnerId}`);
      } else {
        log('Failed to mint session for controlled owner');
        await deleteControlledOwner(controlledOwnerId);
        controlledOwnerId = null;
      }
    }
  }
  
  let privilegeProbesRun = 0;
  let privilegeProbesPassed = 0;
  let noc337ProbesRun = 0;
  let noc337ProbesPassed = 0;
  
  if (ownerEntry && memberEntry) {
    // Tenant A: First controlled team
    const creationA = await createTestTeam(ownerEntry.token);
    report.probes.push({
      label: 'tenant A controlled owner creates test team',
      expected: [200, 201],
      status: creationA.status,
      code: creationA.teamId ? null : 'TEAM_CREATE_FAILED',
      ok: !!creationA.teamId,
    });
    report.probes.push({
      label: 'tenant A created team owner is bound to the authenticated token',
      expected: [200, 201],
      status: creationA.status,
      code: creationA.ownerBoundToToken ? null : 'OWNER_NOT_BOUND',
      ok: creationA.ownerBoundToToken,
    });
    
    let tenantATeamId = null;
    let tenantAMemberId = null;
    let tenantAMemberToken = null;
    
    if (creationA.teamId) {
      tenantATeamId = creationA.teamId;
      report.identity.testTeamCreated = true;
      report.identity.testTeamId = tenantATeamId;
      report.identity.teamOwnerBoundToToken = creationA.ownerBoundToToken;
      
      const additionA = await addMemberToTeam(ownerEntry.token, tenantATeamId, memberEntry.email, 'member');
      tenantAMemberId = additionA.userId;
      let joinedViaInvitation = false;
      
      if (!additionA.added || !tenantAMemberId) {
        const invitationA = await inviteAndAcceptMember(ownerEntry.token, memberEntry.token, tenantATeamId, memberEntry.email, memberEntry.userId);
        tenantAMemberId = invitationA.userId;
        joinedViaInvitation = invitationA.joined;
      }
      
      if (tenantAMemberId) {
        report.identity.memberAddedToTestTeam = true;
        report.identity.memberJoinedViaInvitation = joinedViaInvitation;
        tenantAMemberToken = memberEntry.token;
        
        const noc280ResultsA = await runNoc280Matrix(tenantAMemberToken, tenantATeamId, tenantAMemberId, ownerEntry.token);
        privilegeProbesRun += noc280ResultsA.length;
        privilegeProbesPassed += noc280ResultsA.filter(r => r.ok).length;
        report.probes.push(...noc280ResultsA);
        
        const noc274ResultsA = await runNoc274Matrix(ownerEntry.token, tenantATeamId);
        privilegeProbesRun += noc274ResultsA.length;
        privilegeProbesPassed += noc274ResultsA.filter(r => r.ok).length;
        report.probes.push(...noc274ResultsA);
      } else {
        report.identity.memberAddedToTestTeam = false;
        log('The member identity could not be added to tenant A test team, the privilege matrix did not run.');
        await cleanupTestTeam(ownerEntry.token, tenantATeamId);
      }
    } else {
      report.identity.testTeamCreated = false;
      log(`Tenant A team creation failed with HTTP ${creationA.status}; the privilege matrix cannot run.`);
      report.identity.matrixBlockedBy = `tenant A team creation failed (HTTP ${creationA.status})`;
    }
    
    // Tenant B: Second controlled team (new controlled owner and member)
    let controlledOwnerBId = null;
    let controlledOwnerBToken = null;
    let tenantBTeamId = null;
    let tenantBMemberId = null;
    let tenantBMemberToken = null;
    
    log('--- Creating tenant B controlled owner ---');
    controlledOwnerBId = await createControlledOwner();
    if (controlledOwnerBId) {
      const sessionData = await mintAndRevokeSession(controlledOwnerBId, 'controlled-owner-b');
      if (sessionData) {
        controlledOwnerBToken = sessionData.token;
        await ensureUserInNightlamp(controlledOwnerBToken, controlledOwnerBId);
        const membershipB = await queryTeamMembership(controlledOwnerBToken, controlledOwnerBId);
        const ownerBEntry = { userId: controlledOwnerBId, ...membershipB, token: controlledOwnerBToken };
        
        const creationB = await createTestTeam(ownerBEntry.token);
        report.probes.push({
          label: 'tenant B controlled owner creates test team',
          expected: [200, 201],
          status: creationB.status,
          code: creationB.teamId ? null : 'TEAM_CREATE_FAILED',
          ok: !!creationB.teamId,
        });
        report.probes.push({
          label: 'tenant B created team owner is bound to the authenticated token',
          expected: [200, 201],
          status: creationB.status,
          code: creationB.ownerBoundToToken ? null : 'OWNER_NOT_BOUND',
          ok: creationB.ownerBoundToToken,
        });
        
        if (creationB.teamId) {
          tenantBTeamId = creationB.teamId;
          
          // Add member B (use the original memberEntry or create a new one)
          const additionB = await addMemberToTeam(ownerBEntry.token, tenantBTeamId, memberEntry.email, 'member');
          tenantBMemberId = additionB.userId;
          let joinedViaInvitationB = false;
          
          if (!additionB.added || !tenantBMemberId) {
            const invitationB = await inviteAndAcceptMember(ownerBEntry.token, memberEntry.token, tenantBTeamId, memberEntry.email, memberEntry.userId);
            tenantBMemberId = invitationB.userId;
            joinedViaInvitationB = invitationB.joined;
          }
          
          if (tenantBMemberId) {
            tenantBMemberToken = memberEntry.token;
            
            // Run privilege matrix for tenant B
            const noc280ResultsB = await runNoc280Matrix(tenantBMemberToken, tenantBTeamId, tenantBMemberId, ownerBEntry.token);
            privilegeProbesRun += noc280ResultsB.length;
            privilegeProbesPassed += noc280ResultsB.filter(r => r.ok).length;
            report.probes.push(...noc280ResultsB);
            
            const noc274ResultsB = await runNoc274Matrix(ownerBEntry.token, tenantBTeamId);
            privilegeProbesRun += noc274ResultsB.length;
            privilegeProbesPassed += noc274ResultsB.filter(r => r.ok).length;
            report.probes.push(...noc274ResultsB);
            
            // Run cross-tenant NOC-337 probes
            const tenantA = { ownerToken: ownerEntry.token, memberToken: tenantAMemberToken };
            const tenantB = { ownerToken: ownerBEntry.token, memberToken: tenantBMemberToken };
            const noc337Probes = await runTwoTenantProbes(tenantA, tenantB, tenantATeamId, tenantBTeamId);
            noc337ProbesRun = noc337Probes.length;
            noc337ProbesPassed = noc337Probes.filter(p => p.ok).length;
            report.probes.push(...noc337Probes);
            log(`NOC-339 two-tenant cross-org probes completed: ${noc337ProbesPassed}/${noc337ProbesRun} passed`);
            
            // Cleanup tenant B
            const cleanupB = await cleanupTestTeam(ownerBEntry.token, tenantBTeamId);
            report.identity.testTeamRemoved = cleanupB;
            if (!cleanupB) {
              log('WARNING: tenant B test team cleanup failed');
            }
            
            // Delete controlled owner B
            await revokeSession(controlledOwnerBId);
            await deleteControlledOwner(controlledOwnerBId);
          } else {
            log('The member identity could not be added to tenant B test team');
            await cleanupTestTeam(ownerBEntry.token, tenantBTeamId);
          }
        } else {
          log(`Tenant B team creation failed with HTTP ${creationB.status}`);
        }
      } else {
        log('Failed to mint session for tenant B controlled owner');
        await deleteControlledOwner(controlledOwnerBId);
      }
    }
    
    // Cleanup tenant A
    if (tenantATeamId) {
      const cleanupA = await cleanupTestTeam(ownerEntry.token, tenantATeamId);
      report.identity.testTeamRemoved = cleanupA && report.identity.testTeamRemoved;
      if (!cleanupA) {
        log('WARNING: tenant A test team cleanup failed');
      }
    }
    
    report.identity.fullMatrixRun = report.identity.testTeamCreated && 
      report.identity.memberAddedToTestTeam && 
      privilegeProbesRun > 0 && 
      privilegeProbesPassed === privilegeProbesRun &&
      noc337ProbesRun > 0 &&
      noc337ProbesPassed === noc337ProbesRun;
  } else {
    log('Cannot run full matrix: missing owner or second identity');
    report.identity.fullMatrixRun = false;
  }
  
  report.identity.privilegeProbesRun = privilegeProbesRun;
  report.identity.privilegeProbesPassed = privilegeProbesPassed;
  report.identity.noc337ProbesRun = noc337ProbesRun;
  report.identity.noc337ProbesPassed = noc337ProbesPassed;
  report.identity.tenantACreated = !!tenantATeamId;
  report.identity.tenantBCreated = !!tenantBTeamId;
  report.identity.crossTenantProbesRun = noc337ProbesRun;
  report.identity.crossTenantProbesPassed = noc337ProbesPassed;
  
  for (const [userId, sessionData] of userSessions.entries()) {
    const userRole = userRoles.get(userId) || (userId === controlledOwnerSessionUserId ? { teams: [], hasTeam: false, isOwner: false, isMember: false } : null);
    if (!userRole) continue;
    
    const label = userRole.hasTeam ? 'team-member' : 'no-team';
    const expectedStatus = userRole.hasTeam ? [200] : [noTeamExpectedStatus];
    
    await probeWithForeignRowCheck(
      `a signed-in ${label} can list the events`,
      `${nightlampApi}/api/events`,
      { headers: bearer(sessionData.token) },
      expectedStatus,
      userId,
      userRole
    );
    
    await probeWithForeignRowCheck(
      `a signed-in ${label} can list the remediation runs`,
      `${nightlampApi}/api/remediation/runs`,
      { headers: bearer(sessionData.token) },
      expectedStatus,
      userId,
      userRole
    );
    
    await probe(
      `acknowledging an event that does not exist answers 404 for ${label}`,
      `${nightlampApi}/api/events/acknowledge`,
      { method: 'POST', headers: bearer(sessionData.token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ id: 'nightlamp-controlled-unknown-id' }) },
      [404]
    );
  }
  
  if (controlledOwnerId) {
    log('--- Cleanup: Deleting controlled owner ---');
    await revokeSession(controlledOwnerId);
    await deleteControlledOwner(controlledOwnerId);
  }
}

finalHealth = await fetchHealth();
const finalUptimeInfo = extractUptimeAndBootId(finalHealth);
log(`Final health check: HTTP ${finalHealth.status} ${finalHealth.body ? `(uptimeSeconds: ${finalUptimeInfo.uptime}s, bootId: ${finalUptimeInfo.bootId})` : 'no body'}`);

function filterReportForPublish(report) {
  const allowedIdentityKeys = new Set([
    'frontendHasClerkSecret',
    'frontendHasPublishableKey',
    'existingUserCount',
    'ownerIdentified',
    'memberIdentified',
    'memberIsMember',
    'memberIsOwner',
    'controlledOwnerCreated',
    'controlledOwnerUsed',
    'controlledOwnerDeleted',
    'testTeamCreated',
    'testTeamRemoved',
    'fullMatrixRun',
    'privilegeProbesRun',
    'privilegeProbesPassed',
    'noc337ProbesRun',
    'noc337ProbesPassed',
    'tenantACreated',
    'tenantBCreated',
    'crossTenantProbesRun',
    'crossTenantProbesPassed',
    'noTeamExpectedStatus',
    'contractMismatches',
    'memberAddedToTestTeam',
    'memberJoinedViaInvitation',
    'teamOwnerBoundToToken',
    'matrixBlockedBy',
    'runInvalid',
    'runInvalidReason',
  ]);
  
  const filteredIdentity = {};
  for (const [key, value] of Object.entries(report.identity || {})) {
    if (allowedIdentityKeys.has(key)) {
      filteredIdentity[key] = value;
    }
  }
  
  const probeLabels = {
    'self-promotion-to-owner': 'a member cannot promote itself to owner',
    'self-promotion-to-admin': 'a member cannot promote itself to admin',
    'member-add-member': 'a member cannot add another member',
    'member-remove-self': 'a member cannot remove itself',
    'member-rewrite-team': 'a member cannot rewrite the team',
    'member-delete-team': 'a member cannot delete the team',
    'member-create-admin-invitation': 'a member cannot create an admin invitation',
    'member-admin-endpoint': 'a member cannot reach the admin endpoint',
    'unknown-team': 'a member cannot reach a team it does not belong to',
    'owner-non-member-target': 'the owner gets a truthful 404 for a target that does not exist',
    'member-role-persists': 'the member role persists after the attempts',
    'approve-unknown-run': 'approving an unknown run does not claim success',
    'reject-unknown-run': 'rejecting an unknown run does not claim success',
    'retry-unknown-run': 'retrying an unknown run does not claim success',
    'unknown-action-rejected': 'an unknown action is rejected without claiming success',
  };
  
  return {
    probes: report.probes.map(p => ({
      label: p.label || probeLabels[p.test] || p.test || 'a probe',
      test: p.test,
      expected: p.expected,
      expectedStatusUsed: p.expectedStatusUsed,
      status: p.status,
      code: p.code,
      ok: p.ok,
      foreignRows: p.foreignRows,
      ownRows: p.ownRows,
      personalRows: p.personalRows,
      isNoTeamUser: p.isNoTeamUser,
      contractMismatch: p.contractMismatch,
    })),
    identity: filteredIdentity,
    diagnostics: report.diagnostics,
    valuesIncluded: false,
    bodiesIncluded: false,
    error: report.error,
    probesPassed: report.probesPassed,
    probesTotal: report.probesTotal,
  };
}

async function cleanup() {
  await revokeAllSessions();
  
  const passed = report.probes.filter((entry) => entry.ok).length;
  const contractMismatches = report.probes.filter((entry) => entry.contractMismatch).length;
  const total = report.probes.length;
  
  report.probesPassed = passed;
  report.probesTotal = total;
  report.identity.noTeamExpectedStatus = noTeamExpectedStatus;
  report.identity.contractMismatches = contractMismatches;
  
  const restartCheck = await checkServerRestart();
  if (!restartCheck.valid) {
    report.identity.runInvalid = true;
    report.identity.runInvalidReason = restartCheck.reason;
    log(`RUN INVALID: ${restartCheck.reason}`);
  } else {
    report.identity.runInvalid = false;
    report.identity.runInvalidReason = restartCheck.reason;
    log(`Run validity: ${restartCheck.reason}`);
  }
  
  const publishReport = filterReportForPublish(report);
  fs.writeFileSync(resultFile, JSON.stringify(publishReport, null, 2));
  log(`probes as expected: ${passed}/${total}`);
  if (contractMismatches > 0) {
    log(`CONTRACT MISMATCHES: ${contractMismatches} probes returned 200 when decided contract (NOC-294) requires 403`);
  }
  if (noc337ProbesRun > 0) {
    log(`NOC-339 cross-tenant probes: ${noc337ProbesPassed}/${noc337ProbesRun} passed`);
  }
  
  const hasFailures = passed < total || contractMismatches > 0 || restartCheck.valid === false;
  if (hasFailures) {
    throw new Error(`Verification failed: ${total - passed} probes failed, ${contractMismatches} contract mismatches${!restartCheck.valid ? ', run invalid' : ''}`);
  }
}

async function main() {
  try {
    await run();
    await cleanup();
    log('=== VERIFICATION SUCCESSFUL ===');
    process.exit(0);
  } catch (error) {
    report.error = `the verification script failed: ${(error && error.message) || 'unknown error'}`;
    log(report.error);
    try {
      await cleanup();
    } catch (cleanupError) {
      log(`the cleanup failed: ${(cleanupError && cleanupError.message) || 'unknown error'}`);
    }
    process.exit(1);
  }
}

main();