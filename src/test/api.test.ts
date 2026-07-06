import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { getOrCreatePlaybookEntry } from '../playbook';

describe('API Server', () => {
  let db: Database;
  let server: Server;
  let port: number;

  before(async () => {
    db = await createDatabase();

    db.run('INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)',
      ['f-api-1', 'c1', 'expired_token', 'critical', 'Token expired', 'desc']);
    db.run('INSERT INTO failure_events (id, check_id, failure_type, severity, title, description) VALUES (?, ?, ?, ?, ?, ?)',
      ['f-api-2', 'c1', 'rate_limit_shift', 'warning', 'Rate limited', 'desc']);
    db.run('INSERT INTO check_results (id, check_id, status, summary) VALUES (?, ?, ?, ?)',
      ['r-api-1', 'c1', 'pass', 'All good']);
    db.run('INSERT INTO playbook_entries (id, failure_type, title, body) VALUES (?, ?, ?, ?)',
      ['p-api-1', 'expired_token', 'Expired Token', 'body with token symptoms']);
    db.run('INSERT INTO playbook_entries (id, failure_type, title, body) VALUES (?, ?, ?, ?)',
      ['p-api-2', 'broken_webhook', 'Broken Webhook', 'body with 5xx symptoms']);

    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  it('GET /api/health returns status ok', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as any;
    assert.strictEqual(res.status, 'ok');
    assert.ok(res.stats.failureEvents >= 2);
    assert.ok(res.stats.playbookEntries >= 1);
  });

  it('GET /api/events returns failure events', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json() as any;
    assert.ok(res.count >= 2);
    assert.ok(res.events.some((e: any) => e.failureType === 'expired_token'));
  });

  it('GET /api/events?type= filters by type', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/events?type=rate_limit_shift`)).json() as any;
    assert.strictEqual(res.count, 1);
    assert.strictEqual(res.events[0].failureType, 'rate_limit_shift');
  });

  it('GET /api/check-results returns results', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/check-results`)).json() as any;
    assert.ok(res.count >= 1);
    assert.strictEqual(res.results[0].status, 'pass');
  });

  it('GET /api/playbook returns entries', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook`)).json() as any;
    assert.ok(res.count >= 1);
    assert.strictEqual(res.entries[0].failureType, 'expired_token');
  });

  it('GET /api/playbook/search returns matching entries', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/search?q=token`)).json() as any;
    assert.ok(res.count >= 1);
    assert.ok(res.entries.some((e: any) => e.failureType === 'expired_token'));
  });

  it('GET /api/playbook/search returns empty for no match', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/search?q=zzzznonexistent`)).json() as any;
    assert.strictEqual(res.count, 0);
  });

  it('GET /api/playbook/match returns matches by symptom', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/match?symptoms=5xx`)).json() as any;
    assert.ok(res.count >= 1);
    assert.ok(res.matches.some((m: any) => m.failureType === 'broken_webhook'));
  });

  it('GET /api/playbook/match returns empty for no match', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/match?symptoms=zzzznonexistent`)).json() as any;
    assert.strictEqual(res.count, 0);
  });

  it('GET /api/unknown returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/unknown`);
    assert.strictEqual(res.status, 404);
  });

  it('POST /api/playbook/remediate triggers remediation and returns log', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/playbook/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failureType: 'expired_token' }),
    });
    const data = await res.json() as any;
    assert.ok(data.logId, 'should return a log ID');
    assert.ok(['success', 'failed'].includes(data.status), `status should be success or failed, got ${data.status}`);
    assert.ok(data.output.length > 0, 'should have output text');
  });

  it('POST /api/playbook/remediate requires failureType', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/playbook/remediate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
    const data = await res.json() as any;
    assert.ok(data.error.includes('failureType'));
  });

  it('GET /api/playbook/remediation-logs returns logs', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/remediation-logs`)).json() as any;
    assert.ok(Array.isArray(res.logs));
  });

  it('GET /api/playbook/correlations returns correlations', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/correlations?failureType=expired_token`)).json() as any;
    assert.ok(Array.isArray(res.correlations));
    assert.strictEqual(res.failureType, 'expired_token');
  });

  it('GET /api/playbook/correlations returns empty for no failureType', async () => {
    const res = await (await fetch(`http://127.0.0.1:${port}/api/playbook/correlations`)).json() as any;
    assert.strictEqual(res.count, 0);
  });

  describe('X/Twitter API', () => {
    before(() => {
      process.env.X_CLIENT_ID = 'test-client-id';
      process.env.X_CLIENT_SECRET = 'test-client-secret';
    });

    after(() => {
      delete process.env.X_CLIENT_ID;
      delete process.env.X_CLIENT_SECRET;
    });

    it('GET /api/x/auth returns authorize URL', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/x/auth`)).json() as any;
      assert.ok(res.authorizeUrl.startsWith('https://twitter.com/i/oauth2/authorize'));
      assert.ok(res.state.length > 0);
    });

    it('POST /api/x/schedule creates pending posts', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const res = await fetch(`http://127.0.0.1:${port}/api/x/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweets: ['First tweet', 'Second tweet'], scheduledAt: futureDate }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.count, 2);
      assert.ok(Array.isArray(data.postIds));
      assert.strictEqual(data.postIds.length, 2);

      for (const id of data.postIds) {
        db.run('DELETE FROM x_scheduled_posts WHERE id = ?', [id]);
      }
    });

    it('POST /api/x/schedule rejects missing tweets', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/x/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scheduledAt: new Date().toISOString() }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('POST /api/x/schedule rejects empty tweets array', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/x/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweets: [], scheduledAt: new Date().toISOString() }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('POST /api/x/schedule rejects missing scheduledAt', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/x/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweets: ['test'] }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('POST /api/x/schedule rejects invalid scheduledAt', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/x/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tweets: ['test'], scheduledAt: 'not-a-date' }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('GET /api/x/status returns authenticated false with no tokens', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/x/status`)).json() as any;
      assert.strictEqual(res.authenticated, false);
    });

    it('GET /api/x/posts returns posts array', async () => {
      const res = await (await fetch(`http://127.0.0.1:${port}/api/x/posts`)).json() as any;
      assert.ok(Array.isArray(res.posts));
    });
  });
});