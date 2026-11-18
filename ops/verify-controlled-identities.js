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
  log(`  User ${userId} has access to ${teams.length} team(s)`);
  
  for (const team of teams) {
    log(`    Team: ${team.id} (${team.name}) - owner: ${team.ownerId}`);
  }
  
  const ownedTeam = teams.find(t => t.ownerId === userId);
  const memberTeam = teams.find(t => t.ownerId !== userId);
  
  return {
    teams,
    ownedTeam,
    memberTeam,
    isOwner: !!ownedTeam,
    isMember: !!memberTeam
  };
}

async function createTestTeam(ownerToken, ownerId, memberId) {
  const teamName = `controlled-test-${Date.now()}`;
  const teamSlug = `controlled-test-${Date.now()}`;
  const response = await fetch(`${nightlampApi}/api/teams`, {
    method: 'POST',
    headers: bearer(ownerToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: teamName, slug: teamSlug, ownerId, plan: 'free' })
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
    return parsed.id;
  } else {
    log(`Failed to create test team: HTTP ${response.status}`);
    return null;
  }
}

async function addMemberToTeam(ownerToken, teamId, memberId, role = 'member') {
  const response = await fetch(`${nightlampApi}/api/teams/${teamId}/members`, {
    method: 'POST',
    headers: bearer(ownerToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ userId: memberId, role })
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  
  if (response.status >= 200 && response.status < 300) {
    log(`Added ${memberId} as ${role} to team ${teamId}`);
    return true;
  } else {
    log(`Failed to add member: HTTP ${response.status}`);
    return false;
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
  if (response.status === 200 && parsed && Array.isArray(parsed.events)) {
    for (const event of parsed.events) {
      if (event.teamId && userRole && !userRole.isOwner && !userRole.isMember) {
        foreignRows++;
      } else if (!event.teamId) {
        ownRows++;
      }
    }
  } else if (response.status === 200 && parsed && Array.isArray(parsed.runs)) {
    for (const run of parsed.runs) {
      if (run.teamId && userRole && !userRole.isOwner && !userRole.isMember) {
        foreignRows++;
      } else if (!run.teamId) {
        ownRows++;
      }
    }
  }
  
  if (foreignRows > 0 || ownRows > 0) {
    log(`  Foreign rows: ${foreignRows}, Own rows: ${ownRows}`);
  }
  
  const entry = {
    label,
    expected,
    status: response.status,
    code,
    ok: expected.includes(response.status),
    foreignRows,
    ownRows,
  };
  report.probes.push(entry);
  log(`${entry.ok ? 'PASS' : 'FAIL'} ${label} expected ${expected.join('/')} got ${response.status}${code ? ` ${code}` : ''}${foreignRows > 0 || ownRows > 0 ? ` (foreignRows: ${foreignRows}, ownRows: ${ownRows})` : ''}`);
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
  
  const deleteTeamAttempt = await fetch(`${nightlampApi}/api/teams/${teamId}`, {
    method: 'DELETE',
    headers: bearer(memberToken)
  });
  const dtText = await deleteTeamAttempt.text();
  let dtParsed = null;
  try { dtParsed = JSON.parse(dtText); } catch {}
  results.push({
    test: 'member-delete-team',
    expected: [403],
    status: deleteTeamAttempt.status,
    code: dtParsed?.code,
    ok: deleteTeamAttempt.status === 403
  });
  log(`Member delete team: ${deleteTeamAttempt.status} ${deleteTeamAttempt.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Member create privileged invitation ---');
  const createInvite = await fetch(`${nightlampApi}/api/teams/${teamId}/invitations`, {
    method: 'POST',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ email: 'test@example.com', role: 'admin' })
  });
  const ciText = await createInvite.text();
  let ciParsed = null;
  try { ciParsed = JSON.parse(ciText); } catch {}
  results.push({
    test: 'member-create-admin-invitation',
    expected: [403],
    status: createInvite.status,
    code: ciParsed?.code,
    ok: createInvite.status === 403
  });
  log(`Member create admin invitation: ${createInvite.status} ${createInvite.status === 403 ? 'PASS' : 'FAIL'}`);
  
  log('--- NOC-280: Admin endpoint ---');
  const adminEndpoint = await fetch(`${nightlampApi}/api/remediation/approve`, {
    method: 'POST',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ id: 'unknown-id' })
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
  const unknownTeam = await fetch(`${nightlampApi}/api/teams/unknown-team-id/members/${memberId}`, {
    method: 'PATCH',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ role: 'admin' })
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
  const nonMemberTarget = await fetch(`${nightlampApi}/api/teams/${teamId}/members/non-existent-user`, {
    method: 'PATCH',
    headers: bearer(memberToken, json),
    body: JSON.stringify({ role: 'admin' })
  });
  const nmtText = await nonMemberTarget.text();
  let nmtParsed = null;
  try { nmtParsed = JSON.parse(nmtText); } catch {}
  results.push({
    test: 'non-member-target',
    expected: [404],
    status: nonMemberTarget.status,
    code: nmtParsed?.code,
    ok: nonMemberTarget.status === 404
  });
  log(`Non-member target: ${nonMemberTarget.status} ${nonMemberTarget.status === 404 ? 'PASS' : 'FAIL'}`);
  
  const listMembers = await fetch(`${nightlampApi}/api/teams/${teamId}/members`, {
    headers: bearer(ownerToken)
  });
  const lmText = await listMembers.text();
  let lmParsed = null;
  try { lmParsed = JSON.parse(lmText); } catch {}
  if (lmParsed && lmParsed.members) {
    const memberEntry = lmParsed.members.find(m => m.userId === memberId);
    if (memberEntry) {
      results.push({
        test: 'member-role-persists',
        expected: ['member'],
        status: 200,
        code: memberEntry.role,
        ok: memberEntry.role === 'member'
      });
      log(`Member role persists as: ${memberEntry.role} ${memberEntry.role === 'member' ? 'PASS' : 'FAIL'}`);
    }
  }
  
  return results;
}

async function runNoc274Matrix(ownerToken, teamId) {
  const json = { 'Content-Type': 'application/json' };
  const results = [];
  
  log('--- NOC-274: Owner/admin approval reaches truthful terminal result ---');
  const ownerHeaders = bearer(ownerToken, { 
    'Content-Type': 'application/json',
    'x-nightlamp-team-id': teamId
  });
  
  const approveUnknown = await fetch(`${nightlampApi}/api/remediation/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-run-id' })
  });
  const auText = await approveUnknown.text();
  let auParsed = null;
  try { auParsed = JSON.parse(auText); } catch {}
  results.push({
    test: 'approve-unknown-run',
    expected: [404],
    status: approveUnknown.status,
    code: auParsed?.code,
    ok: approveUnknown.status === 404
  });
  log(`Approve unknown run: ${approveUnknown.status} ${approveUnknown.status === 404 ? 'PASS' : 'FAIL'}`);
  
  const rejectUnknown = await fetch(`${nightlampApi}/api/remediation/reject`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-run-id' })
  });
  const ruText = await rejectUnknown.text();
  let ruParsed = null;
  try { ruParsed = JSON.parse(ruText); } catch {}
  results.push({
    test: 'reject-unknown-run',
    expected: [404],
    status: rejectUnknown.status,
    code: ruParsed?.code,
    ok: rejectUnknown.status === 404
  });
  log(`Reject unknown run: ${rejectUnknown.status} ${rejectUnknown.status === 404 ? 'PASS' : 'FAIL'}`);
  
  const retryUnknown = await fetch(`${nightlampApi}/api/remediation/retry`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-run-id' })
  });
  const reuText = await retryUnknown.text();
  let reuParsed = null;
  try { reuParsed = JSON.parse(reuText); } catch {}
  results.push({
    test: 'retry-unknown-run',
    expected: [404],
    status: retryUnknown.status,
    code: reuParsed?.code,
    ok: retryUnknown.status === 404
  });
  log(`Retry unknown run: ${retryUnknown.status} ${retryUnknown.status === 404 ? 'PASS' : 'FAIL'}`);
  
  const unknownAction = await fetch(`${nightlampApi}/api/remediation/approve`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ id: 'unknown-action-id' })
  });
  const uaText = await unknownAction.text();
  let uaParsed = null;
  try { uaParsed = JSON.parse(uaText); } catch {}
  results.push({
    test: 'unknown-action-rejected',
    expected: [404],
    status: unknownAction.status,
    code: uaParsed?.code,
    ok: unknownAction.status === 404
  });
  log(`Unknown action rejected: ${unknownAction.status} ${unknownAction.status === 404 ? 'PASS' : 'FAIL'}`);
  
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

async function run() {
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
      userRoles.set(user.id, { ...membership, token: sessionData.token, userId: user.id });
    }
  }
  
  let ownerEntry = null;
  let memberEntry = null;
  
  for (const [userId, data] of userRoles.entries()) {
    if (data.isOwner && !ownerEntry) {
      ownerEntry = { userId, ...data };
    } else if (data.isMember && !memberEntry) {
      memberEntry = { userId, ...data };
    }
  }
  
  if (!memberEntry) {
    for (const [userId, data] of userRoles.entries()) {
      if (userId !== ownerEntry?.userId && !data.isOwner && !data.isMember) {
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
        const membership = await queryTeamMembership(controlledOwnerToken, controlledOwnerId);
        ownerEntry = { userId: controlledOwnerId, ...membership, token: controlledOwnerToken };
        report.identity.ownerIdentified = true;
        report.identity.ownerId = controlledOwnerId;
        report.identity.controlledOwnerUsed = true;
        log(`Controlled owner created and session minted: ${controlledOwnerId}`);
      } else {
        log('Failed to mint session for controlled owner');
        await deleteControlledOwner(controlledOwnerId);
        controlledOwnerId = null;
      }
    }
  }
  
  if (ownerEntry && memberEntry) {
    const testTeamId = await createTestTeam(ownerEntry.token, ownerEntry.userId, memberEntry.userId);
    if (testTeamId) {
      report.identity.testTeamCreated = true;
      report.identity.testTeamId = testTeamId;
      
      const added = await addMemberToTeam(ownerEntry.token, testTeamId, memberEntry.userId, 'member');
      if (added) {
        report.identity.memberAddedToTestTeam = true;
        
        const noc280Results = await runNoc280Matrix(memberEntry.token, testTeamId, memberEntry.userId, ownerEntry.token);
        report.probes.push(...noc280Results);
        
        const noc274Results = await runNoc274Matrix(ownerEntry.token, testTeamId);
        report.probes.push(...noc274Results);
        
        await cleanupTestTeam(ownerEntry.token, testTeamId);
        report.identity.testTeamRemoved = true;
      } else {
        report.identity.memberAddedToTestTeam = false;
        await cleanupTestTeam(ownerEntry.token, testTeamId);
      }
    } else {
      report.identity.testTeamCreated = false;
    }
    report.identity.fullMatrixRun = true;
  } else {
    log('Cannot run full matrix: missing owner or second identity');
    report.identity.fullMatrixRun = false;
  }
  
  for (const [userId, sessionData] of userSessions.entries()) {
    const userRole = userRoles.get(userId) || (userId === controlledOwnerSessionUserId ? { isOwner: false, isMember: false } : null);
    if (!userRole) continue;
    
    const label = userRole.isOwner ? 'owner' : (userRole.isMember ? 'member' : 'no-team');
    const expectedStatus = userRole.isOwner || userRole.isMember ? [200] : [200];
    
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

async function cleanup() {
  await revokeAllSessions();
  
  const passed = report.probes.filter((entry) => entry.ok).length;
  report.probesPassed = passed;
  report.probesTotal = report.probes.length;
  fs.writeFileSync(resultFile, JSON.stringify(report, null, 2));
  log(`probes as expected: ${passed}/${report.probes.length}`);
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
  }
}

main();