import * as crypto from 'crypto';
import { createDatabase } from '../src/db/schema';
import { startApiServer } from '../src/api/server';
import { v4 as uuidv4 } from 'uuid';

const JWT_SECRET = 'nightlamp-journey-secret';
process.env.CLERK_JWT_SECRET = JWT_SECRET;

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(orgId: string, sub = 'journey-clerk-user'): string {
  const now = Math.floor(Date.now() / 1000);
  const input = `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({
    sub,
    email: 'journey@example.com',
    org_id: orgId,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(input).digest('base64url');
  return `${input}.${signature}`;
}

async function main(): Promise<void> {
  const db = await createDatabase();

  const userId = 'journey-user';
  db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
    [userId, 'journey-clerk-user', 'journey@example.com', 'Journey User']);

  const teamId = uuidv4();
  db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
    [teamId, 'Journey Team', 'journey-team', userId, 'team']);
  db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
    [uuidv4(), teamId, userId, 'owner']);

  const otherTeamId = uuidv4();
  db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
    [otherTeamId, 'Other Team', 'other-team', userId, 'other']);
  db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
    [uuidv4(), otherTeamId, userId, 'owner']);

  const server = startApiServer(db, { port: 0 });
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}`;

  const headers = (team: string) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token(team)}`,
  });

  const post = async (path: string, payload: unknown, team: string = teamId) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: headers(team), body: JSON.stringify(payload) });
    return { status: res.status, body: await res.json() as any };
  };

  const now = new Date().toISOString();
  const steps: any[] = [];

  const emit = async (event: string, properties: Record<string, unknown>, eventId = uuidv4()) => {
    const result = await post('/api/analytics/events', {
      event,
      event_id: eventId,
      schema_version: '1.0',
      timestamp: now,
      properties,
    });
    steps.push({ step: `emit ${event}`, status: result.status, duplicate: result.body.duplicate, event_id: eventId });
    return result;
  };

  await emit('signup_completed', { source: 'landing', plan: 'team', cohort_week: '2026-W47', device_type: 'desktop' });
  await emit('onboarding_step_completed', { step: 'connect', step_number: 1, duration_ms: 4200, provider: 'github', checks_enabled: 3 });
  await emit('first_monitor_created', { monitor_id: 'm-1', monitor_type: 'web', checks_enabled: 3, time_to_first_monitor_ms: 90000 });

  const alertEventId = uuidv4();
  await emit('first_alert_received', {
    alert_id: 'a-1',
    monitor_id: 'm-1',
    severity: 'critical',
    alert_type: 'uptime',
    delivery_channel: 'email',
    time_since_monitor_created_ms: 12000,
  }, alertEventId);

  await emit('alert_acknowledged', { alert_id: 'a-1', incident_id: 'i-1', time_since_delivery_ms: 45000 });
  await emit('playbook_viewed', { playbook_id: 'p-1', incident_id: 'i-1', trigger_source: 'incident_detail', steps_completed: 2, total_steps: 5 });
  await emit('playbook_resolved_incident', {
    playbook_id: 'p-1',
    incident_id: 'i-1',
    time_to_resolve_ms: 240000,
    steps_executed: 5,
    user_initiated: true,
    cause_category: 'dependency',
    fix_category: 'dependency',
  });

  const responseId = uuidv4();
  const feedbackPayload = {
    response_id: responseId,
    kind: 'feedback',
    feedback_type: 'bug_report',
    response: {
      message: 'the dashboard is slow on mobile',
      email: 'person@example.com',
      page_url: 'https://nightlamp.example.com/dashboard?token=abc',
    },
  };
  const firstReceipt = await post('/api/feedback/responses', feedbackPayload);
  steps.push({ step: 'submit feedback response', status: firstReceipt.status, duplicate: firstReceipt.body.duplicate, receipt: firstReceipt.body });

  const retryReceipt = await post('/api/feedback/responses', feedbackPayload);
  steps.push({ step: 'retry feedback response', status: retryReceipt.status, duplicate: retryReceipt.body.duplicate, receipt: retryReceipt.body });

  const retryEvent = await emit('first_alert_received', {
    alert_id: 'a-1',
    monitor_id: 'm-1',
    severity: 'critical',
    alert_type: 'uptime',
    delivery_channel: 'email',
    time_since_monitor_created_ms: 12000,
  }, alertEventId);
  steps.push({ step: 'retry alert event', status: retryEvent.status, duplicate: retryEvent.body.duplicate });

  const surveyReceipt = await post('/api/feedback/responses', {
    response_id: uuidv4(),
    kind: 'survey',
    survey_id: 'nps_day14',
    score: 9,
    response: {},
  });
  steps.push({ step: 'submit nps survey', status: surveyReceipt.status, event: surveyReceipt.body.event });

  const urlPayload = await post('/api/analytics/events', {
    event: 'first_monitor_created',
    event_id: uuidv4(),
    schema_version: '1.0',
    timestamp: now,
    properties: { monitor_id: 'https://nightlamp.example.com/monitor' },
  });
  steps.push({ step: 'reject url payload', status: urlPayload.status, errors: urlPayload.body.errors });

  const futureOutcome = await post('/api/analytics/events', {
    event: 'first_alert_received',
    event_id: uuidv4(),
    schema_version: '1.0',
    timestamp: now,
    properties: { alert_id: 'a-1', action_taken: 'acknowledged' },
  });
  steps.push({ step: 'reject future outcome', status: futureOutcome.status, errors: futureOutcome.body.errors });

  const tenantList = await fetch(`${base}/api/analytics/events`, { headers: headers(otherTeamId) });
  const tenantBody = await tenantList.json() as any;

  const captured = db.exec(
    'SELECT id, event, occurred_at, properties, forwarded, forward_error FROM analytics_events ORDER BY received_at, rowid',
  );
  const records = captured[0].values.map((row: any[]) => ({
    event_id: row[0],
    event: row[1],
    timestamp: row[2],
    properties: JSON.parse(row[3]),
    forwarded: row[4] === 1,
    forward_error: row[4] === 1 ? null : row[5],
  }));

  const responseRows = db.exec('SELECT id, kind, feedback_type, survey_id, score, event_id FROM feedback_responses');
  const responses = responseRows[0].values.map((row: any[]) => ({
    response_id: row[0],
    kind: row[1],
    feedback_type: row[2],
    survey_id: row[3],
    score: row[4],
    event_id: row[5],
  }));

  const textLeak = JSON.stringify(records).includes('the dashboard is slow on mobile');
  const emailLeak = JSON.stringify(records).includes('person@example.com');
  const urlLeak = JSON.stringify(records).includes('nightlamp.example.com');

  console.log(JSON.stringify({
    journey: steps,
    captured_events: records,
    captured_responses: responses,
    counts: {
      analytics_events: records.length,
      feedback_responses: responses.length,
    },
    retry_checks: {
      response_records_after_retry: responses.filter((r) => r.response_id === responseId).length,
      analytics_records_for_retry: records.filter((r) => r.event_id === responseId).length,
      alert_records_after_retry: records.filter((r) => r.event_id === alertEventId).length,
    },
    leak_checks: { text_in_analytics: textLeak, email_in_analytics: emailLeak, url_in_analytics: urlLeak },
    tenant_separation: {
      other_tenant_visible_events: tenantBody.items.length,
      other_tenant_sees_team_events: tenantBody.items.some((item: any) => JSON.stringify(item).includes(teamId)),
    },
  }, null, 2));

  server.close();
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
