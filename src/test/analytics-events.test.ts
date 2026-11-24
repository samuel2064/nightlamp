import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';
import { createTestToken, fetchWithoutAuth, TEST_CLERK_USER_ID, TEST_LOCAL_USER_ID } from './setup';

describe('Analytics ingestion and feedback responses', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;
  let otherTeamId: string;

  const baseUrl = () => `http://127.0.0.1:${port}`;

  const asTeam = (team: string) => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${createTestToken({ org_id: team })}`,
  });

  const asOtherTeam = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${createTestToken({ sub: 'other-clerk-user', org_id: otherTeamId })}`,
  });

  const postEvent = async (payload: unknown, headers: Record<string, string> = asTeam(teamId)) => {
    const res = await fetch(`${baseUrl()}/api/analytics/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const postResponse = async (payload: unknown, headers: Record<string, string> = asTeam(teamId)) => {
    const res = await fetch(`${baseUrl()}/api/feedback/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() as any };
  };

  const validEvent = (overrides: Record<string, unknown> = {}) => ({
    event: 'first_monitor_created',
    event_id: uuidv4(),
    schema_version: '1.0',
    timestamp: new Date().toISOString(),
    properties: { monitor_id: 'monitor-1', monitor_type: 'web', checks_enabled: 3 },
    ...overrides,
  });

  before(async () => {
    db = await createDatabase();

    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [TEST_LOCAL_USER_ID, TEST_CLERK_USER_ID, 'owner-fixture-identity', 'Owner']);
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      ['other-user', 'other-clerk-user', 'other-fixture-identity', 'Other']);

    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'Primary Team', 'primary-team', TEST_LOCAL_USER_ID, 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, TEST_LOCAL_USER_ID, 'owner']);

    otherTeamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [otherTeamId, 'Other Team', 'other-team', 'other-user', 'free']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), otherTeamId, 'other-user', 'owner']);

    server = startApiServer(db, { port: 0 });
    port = (server.address() as any).port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  describe('the protected ingestion endpoint', () => {
    it('requires authentication', async () => {
      const res = await fetchWithoutAuth(`${baseUrl()}/api/analytics/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validEvent()),
      });
      assert.strictEqual(res.status, 401);
    });

    it('accepts a valid event and stores it', async () => {
      const event = validEvent();
      const result = await postEvent(event);

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.success, true);
      assert.strictEqual(result.body.accepted, true);
      assert.strictEqual(result.body.duplicate, false);
      assert.strictEqual(result.body.event_id, event.event_id);

      const rows = db.exec('SELECT event, schema_version FROM analytics_events WHERE id = ?', [event.event_id]);
      assert.strictEqual(rows[0].values.length, 1);
      assert.strictEqual(rows[0].values[0][0], 'first_monitor_created');
    });

    it('hashes the caller identity instead of storing it', async () => {
      const event = validEvent();
      await postEvent(event);

      const rows = db.exec('SELECT properties FROM analytics_events WHERE id = ?', [event.event_id]);
      const properties = JSON.parse(rows[0].values[0][0]);
      assert.ok(/^[a-f0-9]{64}$/.test(properties.user_id_hash));
      assert.ok(/^[a-f0-9]{64}$/.test(properties.organization_id_hash));
      assert.ok(!JSON.stringify(properties).includes(TEST_LOCAL_USER_ID));
      assert.ok(!JSON.stringify(properties).includes(teamId));
    });

    it('rejects an event name outside the contract', async () => {
      const result = await postEvent(validEvent({ event: 'not_a_contract_event' }));
      assert.strictEqual(result.status, 400);
      assert.ok(result.body.errors.some((e: string) => e.includes('not part of the event contract')));
    });

    it('rejects the bespoke flow completion aliases', async () => {
      for (const event of [
        'onboarding_survey_completed',
        'microsurvey_completed',
        'nps_survey_completed',
        'bug_report_submitted',
        'feature_request_submitted',
        'exit_survey_completed',
      ]) {
        const result = await postEvent(validEvent({ event }));
        assert.strictEqual(result.status, 400, `${event} must be rejected`);
      }
    });

    it('rejects a future outcome on an occurrence event', async () => {
      const cases: Array<{ event: string; properties: Record<string, unknown> }> = [
        { event: 'first_alert_received', properties: { alert_id: 'a1', action_taken: 'acknowledged' } },
        { event: 'first_alert_received', properties: { alert_id: 'a1', time_to_action_ms: 1200 } },
        { event: 'playbook_viewed', properties: { playbook_id: 'p1', verdict: 'fixed' } },
        { event: 'playbook_viewed', properties: { playbook_id: 'p1', time_to_resolve_ms: 5000 } },
        { event: 'demo_mode_activated', properties: { entry_point: 'wizard', converted_to_real: true } },
        { event: 'mobile_session', properties: { session_duration_ms: 5000 } },
        { event: 'mobile_session', properties: { page_views: 3 } },
      ];

      for (const testCase of cases) {
        const result = await postEvent(validEvent({
          event: testCase.event,
          properties: testCase.properties,
        }));
        assert.strictEqual(result.status, 400, `${testCase.event} ${JSON.stringify(testCase.properties)} must be rejected`);
      }
    });

    it('accepts the later-observation events', async () => {
      const acknowledged = await postEvent(validEvent({
        event: 'alert_acknowledged',
        properties: { alert_id: 'a1', incident_id: 'i1', time_since_delivery_ms: 4000 },
      }));
      assert.strictEqual(acknowledged.status, 200);

      const summary = await postEvent(validEvent({
        event: 'session_summary',
        properties: { observed_until: new Date().toISOString(), session_duration_ms: 120000, is_final: true },
      }));
      assert.strictEqual(summary.status, 200);
    });

    it('validates the plan enum', async () => {
      for (const plan of ['free', 'pro', 'team', 'enterprise']) {
        const result = await postEvent(validEvent({ properties: { monitor_id: 'm1', plan } }));
        assert.strictEqual(result.status, 200, `plan ${plan} must be accepted`);
      }

      const rejected = await postEvent(validEvent({ properties: { monitor_id: 'm1', plan: 'growth' } }));
      assert.strictEqual(rejected.status, 400);
      assert.ok(rejected.body.errors.some((e: string) => e.includes('plan') && e.includes('must be one of')));

      const trial = await postEvent(validEvent({ properties: { monitor_id: 'm1', plan: 'trial' } }));
      assert.strictEqual(trial.status, 400);
    });

    it('rejects PII property names', async () => {
      for (const properties of [
        { monitor_id: 'm1', email: 'person-fixture-identity' },
        { monitor_id: 'm1', screenshot: 'base64data' },
        { monitor_id: 'm1', description: 'free text' },
        { monitor_id: 'm1', referrer: 'https://example.com' },
      ]) {
        const result = await postEvent(validEvent({ properties }));
        assert.strictEqual(result.status, 400, `${JSON.stringify(properties)} must be rejected`);
      }
    });

    it('rejects PII inside an allowlisted value', async () => {
      const EMAIL_PII_PROBE = ['pii', 'probe.invalid'].join('@');
      const emailValue = await postEvent(validEvent({ properties: { monitor_id: EMAIL_PII_PROBE } }));
      assert.strictEqual(emailValue.status, 400);

      const urlValue = await postEvent(validEvent({ properties: { monitor_id: 'https://example.com/monitor' } }));
      assert.strictEqual(urlValue.status, 400);

      const freeText = await postEvent(validEvent({
        properties: { monitor_id: 'the monitor keeps failing every night since the patch' },
      }));
      assert.strictEqual(freeText.status, 400);
    });

    it('rejects a missing event_id, schema_version or timestamp', async () => {
      const noEventId = validEvent();
      delete (noEventId as any).event_id;
      assert.strictEqual((await postEvent(noEventId)).status, 400);

      const noSchemaVersion = validEvent();
      delete (noSchemaVersion as any).schema_version;
      assert.strictEqual((await postEvent(noSchemaVersion)).status, 400);

      const noTimestamp = validEvent();
      delete (noTimestamp as any).timestamp;
      assert.strictEqual((await postEvent(noTimestamp)).status, 400);
    });

    it('rejects an unknown top-level field', async () => {
      const result = await postEvent(validEvent({ user_agent: 'Mozilla' }));
      assert.strictEqual(result.status, 400);
      assert.ok(result.body.errors.some((e: string) => e.includes('user_agent')));
    });

    it('rejects a non-scalar property value', async () => {
      const nested = await postEvent(validEvent({ properties: { monitor_id: 'm1', metrics_before: { latency_ms: 12 } } }));
      assert.strictEqual(nested.status, 400);

      const array = await postEvent(validEvent({ properties: { monitor_id: 'm1', checks_detail: ['uptime'] } }));
      assert.strictEqual(array.status, 400);
    });

    it('rejects a timestamp in the future', async () => {
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const result = await postEvent(validEvent({ timestamp: future }));
      assert.strictEqual(result.status, 400);
    });

    it('validates the survey_id and feedback_type enums', async () => {
      const badSurvey = await postEvent(validEvent({
        event: 'survey_completed',
        properties: { survey_id: 'not_a_survey' },
      }));
      assert.strictEqual(badSurvey.status, 400);

      const goodSurvey = await postEvent(validEvent({
        event: 'survey_completed',
        properties: { survey_id: 'welcome' },
      }));
      assert.strictEqual(goodSurvey.status, 200);

      const badFeedback = await postEvent(validEvent({
        event: 'feedback_submitted',
        properties: { feedback_type: 'welcome_survey' },
      }));
      assert.strictEqual(badFeedback.status, 400);
    });
  });

  describe('event_id deduplication', () => {
    it('stores one record for a repeated event_id', async () => {
      const event = validEvent();

      const first = await postEvent(event);
      const second = await postEvent(event);

      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.duplicate, false);
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.duplicate, true);
      assert.strictEqual(second.body.event_id, event.event_id);

      const rows = db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [event.event_id]);
      assert.strictEqual(Number(rows[0].values[0][0]), 1);
    });

    it('deduplicates within a tenant but not across tenants', async () => {
      const event = validEvent();

      const first = await postEvent(event);
      const second = await postEvent(event);
      const other = await postEvent(event, asOtherTeam());

      assert.strictEqual(first.body.duplicate, false);
      assert.strictEqual(second.body.duplicate, true);
      assert.strictEqual(other.body.duplicate, false);

      const rows = db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [event.event_id]);
      assert.strictEqual(Number(rows[0].values[0][0]), 2);
    });
  });

  describe('tenant separation', () => {
    it('does not leak events across tenants', async () => {
      const event = validEvent();
      await postEvent(event);

      const res = await fetch(`${baseUrl()}/api/analytics/events`, { headers: asOtherTeam() });
      const body = await res.json() as any;

      assert.strictEqual(res.status, 200);
      assert.ok(!body.items.some((item: any) => item.event_id === event.event_id));
      assert.ok(!JSON.stringify(body).includes(teamId));
    });

    it('does not leak feedback responses across tenants', async () => {
      const responseId = uuidv4();
      await postResponse({
        response_id: responseId,
        kind: 'feedback',
        feedback_type: 'general',
        response: { message: 'the dashboard is slow on mobile' },
      });

      const res = await fetch(`${baseUrl()}/api/feedback/responses/${responseId}`, { headers: asOtherTeam() });
      assert.strictEqual(res.status, 404);
    });
  });

  describe('feedback responses', () => {
    it('accepts a feedback response and emits the canonical event once', async () => {
      const responseId = uuidv4();
      const result = await postResponse({
        response_id: responseId,
        kind: 'feedback',
        feedback_type: 'bug_report',
        response: { message: 'the dashboard is slow on mobile' },
      });

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.success, true);
      assert.strictEqual(result.body.duplicate, false);
      assert.strictEqual(result.body.event, 'feedback_submitted');
      assert.strictEqual(result.body.event_id, responseId);

      const rows = db.exec('SELECT event, properties FROM analytics_events WHERE id = ?', [responseId]);
      assert.strictEqual(rows[0].values.length, 1);
      assert.strictEqual(rows[0].values[0][0], 'feedback_submitted');

      const properties = JSON.parse(rows[0].values[0][1]);
      assert.strictEqual(properties.feedback_type, 'bug_report');
      assert.strictEqual(properties.response_id, responseId);
      assert.ok(!JSON.stringify(properties).includes('the dashboard is slow on mobile'));
    });

    it('returns the same receipt for a retried response and does not duplicate the event', async () => {
      const responseId = uuidv4();
      const payload = {
        response_id: responseId,
        kind: 'feedback',
        feedback_type: 'feature_request',
        response: { message: 'please add a dark mode' },
      };

      const first = await postResponse(payload);
      const second = await postResponse(payload);

      assert.strictEqual(first.body.duplicate, false);
      assert.strictEqual(second.body.duplicate, true);
      assert.strictEqual(second.body.response_id, first.body.response_id);
      assert.strictEqual(second.body.received_at, first.body.received_at);

      const responses = db.exec('SELECT COUNT(*) FROM feedback_responses WHERE id = ?', [responseId]);
      assert.strictEqual(Number(responses[0].values[0][0]), 1);

      const events = db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [responseId]);
      assert.strictEqual(Number(events[0].values[0][0]), 1);
    });

    it('accepts a survey response and derives the NPS category', async () => {
      const responseId = uuidv4();
      const result = await postResponse({
        response_id: responseId,
        kind: 'survey',
        survey_id: 'nps_day14',
        score: 9,
        response: {},
      });

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.event, 'survey_completed');

      const rows = db.exec('SELECT event, properties FROM analytics_events WHERE id = ?', [responseId]);
      const properties = JSON.parse(rows[0].values[0][1]);
      assert.strictEqual(rows[0].values[0][0], 'survey_completed');
      assert.strictEqual(properties.survey_id, 'nps_day14');
      assert.strictEqual(properties.score, 9);
      assert.strictEqual(properties.nps_category, 'promoter');
    });

    it('rejects a mismatched kind and payload', async () => {
      const feedbackWithSurvey = await postResponse({
        response_id: uuidv4(),
        kind: 'feedback',
        feedback_type: 'general',
        survey_id: 'welcome',
        response: {},
      });
      assert.strictEqual(feedbackWithSurvey.status, 400);

      const surveyWithFeedback = await postResponse({
        response_id: uuidv4(),
        kind: 'survey',
        survey_id: 'welcome',
        feedback_type: 'general',
        response: {},
      });
      assert.strictEqual(surveyWithFeedback.status, 400);

      const badSurvey = await postResponse({
        response_id: uuidv4(),
        kind: 'survey',
        survey_id: 'nope',
        response: {},
      });
      assert.strictEqual(badSurvey.status, 400);

      const noResponseId = await postResponse({
        kind: 'feedback',
        feedback_type: 'general',
        response: {},
      });
      assert.strictEqual(noResponseId.status, 400);
    });

    it('keeps the free text out of the analytics payload but inside the response store', async () => {
      const responseId = uuidv4();
      await postResponse({
        response_id: responseId,
        kind: 'feedback',
        feedback_type: 'general',
        response: { message: 'please add a dark mode', email: 'person-fixture-identity' },
      });

      const stored = db.exec('SELECT response FROM feedback_responses WHERE id = ?', [responseId]);
      assert.ok(stored[0].values[0][0].includes('please add a dark mode'));

      const events = db.exec('SELECT properties FROM analytics_events WHERE id = ?', [responseId]);
      assert.ok(!events[0].values[0][0].includes('please add a dark mode'));
      assert.ok(!events[0].values[0][0].includes('person-fixture-identity'));
    });

    it('allows two teamless users to submit feedback with the same response_id without conflict', async () => {
      const responseId = uuidv4();
      const teamlessTokenA = createTestToken({ sub: 'teamless-a-clerk', email: 'a-fixture-identity' });
      const teamlessTokenB = createTestToken({ sub: 'teamless-b-clerk', email: 'b-fixture-identity' });

      const payload = {
        response_id: responseId,
        kind: 'feedback',
        feedback_type: 'bug_report',
        response: { message: 'the dashboard is slow on mobile' },
      };

      const first = await postResponse(payload, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teamlessTokenA}`,
      });
      assert.strictEqual(first.status, 200);
      assert.strictEqual(first.body.duplicate, false);

      const second = await postResponse(payload, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${teamlessTokenB}`,
      });
      assert.strictEqual(second.status, 200);
      assert.strictEqual(second.body.duplicate, false);

      const responses = db.exec('SELECT COUNT(*) FROM feedback_responses WHERE id = ?', [responseId]);
      assert.strictEqual(Number(responses[0].values[0][0]), 2);

      const events = db.exec('SELECT COUNT(*) FROM analytics_events WHERE id = ?', [responseId]);
      assert.strictEqual(Number(events[0].values[0][0]), 2);

      const responseRows = db.exec('SELECT user_id, dedup_key FROM feedback_responses WHERE id = ?', [responseId]);
      assert.strictEqual(responseRows[0].values.length, 2);
      const dedupKeys = new Set(responseRows[0].values.map((row: any) => row[1]));
      assert.strictEqual(dedupKeys.size, 2, 'each teamless user must have a distinct dedup key');
    });
  });

  describe('the forwarding path', () => {
    it('records that no analytics provider is configured instead of faking a forward', async () => {
      const previousKey = process.env.POSTHOG_API_KEY;
      delete process.env.POSTHOG_API_KEY;

      const event = validEvent();
      const result = await postEvent(event);

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.forward_status, 'not_configured');

      const rows = db.exec('SELECT forwarded, forward_error FROM analytics_events WHERE id = ?', [event.event_id]);
      assert.strictEqual(Number(rows[0].values[0][0]), 0);
      assert.ok(String(rows[0].values[0][1]).includes('POSTHOG_API_KEY'));

      if (previousKey !== undefined) process.env.POSTHOG_API_KEY = previousKey;
    });

    it('records the failure when the configured provider is unreachable', async () => {
      const previousKey = process.env.POSTHOG_API_KEY;
      const previousHost = process.env.POSTHOG_HOST;
      process.env.POSTHOG_API_KEY = 'phc_test_key';
      process.env.POSTHOG_HOST = 'http://127.0.0.1:9';

      const event = validEvent();
      const result = await postEvent(event);

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.body.forward_status, 'failed');

      const rows = db.exec('SELECT forwarded, forward_error FROM analytics_events WHERE id = ?', [event.event_id]);
      assert.strictEqual(Number(rows[0].values[0][0]), 0);
      assert.ok(rows[0].values[0][1]);

      if (previousKey === undefined) delete process.env.POSTHOG_API_KEY;
      else process.env.POSTHOG_API_KEY = previousKey;
      if (previousHost === undefined) delete process.env.POSTHOG_HOST;
      else process.env.POSTHOG_HOST = previousHost;
    });
  });
});
