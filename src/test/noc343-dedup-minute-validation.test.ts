import assert from 'assert';
import * as crypto from 'crypto';
import * as http from 'http';
import { Server } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { getDedupFingerprint } from '../notifications/service';
import { mockHostResolver } from './support/dns-mock';

// This suite mints its own HS256 token and speaks to the running server over
// node:http, so it does not depend on src/test/setup.ts (which patches
// globalThis.fetch to inject authentication) and the anonymous case below is a
// real unauthenticated request.
const NOC343_JWT_SECRET = 'noc343-dedup-minutes-edge-secret';
const WEBHOOK_URL = 'https://hooks.slack.com/services/noc343';
const TEAM_USER_ID = 'noc343-dedup-user';
const DEFAULT_WINDOW_MINUTES = 5;
const ACCEPTED_MINUTES = 30;

function mintToken(claims: Record<string, unknown>): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: TEAM_USER_ID,
    email: 'noc343@example.com',
    iat: now,
    exp: now + 3600,
    ...claims,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', NOC343_JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

interface ProbeResponse {
  status: number;
  body: any;
}

function probe(server: Server, path: string, body: unknown, token: string | null): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(text),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const request = http.request({
      host: '127.0.0.1',
      port: (server.address() as any).port,
      path,
      method: 'POST',
      headers,
    }, (response) => {
      let data = '';
      response.on('data', (chunk: string) => { data += chunk; });
      response.on('end', () => {
        let parsed: any = data;
        try { parsed = JSON.parse(data); } catch { /* the raw text is the body */ }
        resolve({ status: response.statusCode || 0, body: parsed });
      });
    });
    request.on('error', reject);
    request.end(text);
  });
}

function sendPayload(channelId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channelId,
    title: 'NOC-343 dedup window',
    description: 'edge validation',
    failureType: 'broken_webhook',
    severity: 'critical',
    checkId: 'noc343-check',
    ...extra,
  };
}

describe('NOC-343: the notification dedup window is validated at the edge', function () {
  let db: Database;
  let server: Server;
  let teamId: string;
  let otherTeamId: string;
  let originalFetch: typeof globalThis.fetch;
  let originalSecret: string | undefined;

  before(function () {
    originalSecret = process.env.CLERK_JWT_SECRET;
    process.env.CLERK_JWT_SECRET = NOC343_JWT_SECRET;
    originalFetch = globalThis.fetch;
    // Delivery reaches a stubbed 200 so the suppression row is written through
    // the product path without any network call.
    globalThis.fetch = (async (input: any) => {
      const url = typeof input === 'string' ? input : input?.url;
      if (String(url).startsWith(WEBHOOK_URL)) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return originalFetch(input);
    }) as typeof globalThis.fetch;
  });

  after(function () {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.CLERK_JWT_SECRET;
    else process.env.CLERK_JWT_SECRET = originalSecret;
  });

  beforeEach(async function () {
    db = await createDatabase();
    teamId = uuidv4();
    otherTeamId = uuidv4();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)', [TEAM_USER_ID, TEAM_USER_ID, 'noc343@example.com', 'Noc343']);
    db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [teamId, 'Own', 'noc343-own', TEAM_USER_ID]);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)', [uuidv4(), teamId, TEAM_USER_ID, 'owner']);
    db.run('INSERT INTO teams (id, name, slug, owner_id) VALUES (?, ?, ?, ?)', [otherTeamId, 'Other', 'noc343-other', 'noc343-other-user']);
    server = startApiServer(db, { port: 0, hostResolver: mockHostResolver });
  });

  afterEach(function () {
    if (server.listening) server.close();
    if (db) db.close();
  });

  function seedChannel(ownerTeamId = teamId): string {
    const channelId = uuidv4();
    db.run(
      `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, 'NOC-343 Channel', 'slack', ?, ?)`,
      [channelId, JSON.stringify({ webhookUrl: WEBHOOK_URL }), ownerTeamId],
    );
    return channelId;
  }

  function dedupRows(): any[] {
    const result = db.exec(
      'SELECT id, channel_id, fingerprint, suppress_until, suppression_count FROM notification_deduplication ORDER BY id',
    );
    return result.length > 0 ? result[0].values.slice() : [];
  }

  function dedupRowsForChannel(channelId: string): any[] {
    const result = db.exec(
      'SELECT id, channel_id, fingerprint, suppress_until, suppression_count FROM notification_deduplication WHERE channel_id = ? ORDER BY id',
      [channelId],
    );
    return result.length > 0 ? result[0].values.slice() : [];
  }

  function suppressUntilFor(channelId: string): string {
    const rows = dedupRowsForChannel(channelId);
    assert.strictEqual(rows.length, 1, 'exactly one suppression row is expected');
    return String(rows[0][3]);
  }

  it('refuses an anonymous caller before the window is read or any row is written', async function () {
    const channelId = seedChannel();
    const response = await probe(server, '/api/notifications/send', sendPayload(channelId), null);
    assert.strictEqual(response.status, 401);
    assert.strictEqual(dedupRowsForChannel(channelId).length, 0);
  });

  it('answers 400 for a dedupMinutes value that is a string and writes no row', async function () {
    const channelId = seedChannel();
    const response = await probe(
      server,
      '/api/notifications/send',
      sendPayload(channelId, { dedupMinutes: 'thirty minutes' }),
      mintToken({ org_id: teamId }),
    );
    assert.strictEqual(response.status, 400);
    assert.ok(String(response.body.error).includes('dedupMinutes'));
    assert.strictEqual(dedupRowsForChannel(channelId).length, 0);
  });

  it('answers 400 for a statement fragment and leaves every existing row byte for byte unchanged', async function () {
    const channelId = seedChannel();
    const payload = sendPayload(channelId);
    const fingerprint = getDedupFingerprint({
      title: String(payload.title),
      description: String(payload.description),
      failureType: String(payload.failureType),
      severity: String(payload.severity),
      detectedAt: '2026-01-01T00:00:00.000Z',
      checkId: String(payload.checkId),
    });
    const existingId = uuidv4();
    const pinnedSuppressUntil = '2020-01-01T00:00:00.000Z';
    db.run(
      `INSERT INTO notification_deduplication (id, channel_id, fingerprint, suppress_until, suppression_count)
       VALUES (?, ?, ?, ?, ?)`,
      [existingId, channelId, fingerprint, pinnedSuppressUntil, 7],
    );
    const before = dedupRows();

    const fragment = `30; UPDATE notification_deduplication SET suppress_until = '2099-01-01T00:00:00.000Z'; --`;
    const response = await probe(
      server,
      '/api/notifications/send',
      sendPayload(channelId, { dedupMinutes: fragment }),
      mintToken({ org_id: teamId }),
    );

    assert.strictEqual(response.status, 400);
    const after = dedupRows();
    assert.strictEqual(after.length, before.length, 'no row may be added or removed');
    assert.deepStrictEqual(after, before, 'every existing row must stay byte for byte unchanged');
    const survivor = after.find((row: any[]) => row[0] === existingId);
    assert.ok(survivor, 'the pre-existing row must still be present');
    assert.strictEqual(survivor[3], pinnedSuppressUntil);
  });

  it('answers 400 for every out-of-range and non-finite number and writes no row', async function () {
    const cases = ['0', '-5', '1441', '1e999'];
    for (const value of cases) {
      const channelId = seedChannel();
      const body = `{"channelId":"${channelId}","title":"NOC-343 dedup window","description":"edge validation","failureType":"broken_webhook","severity":"critical","checkId":"noc343-check","dedupMinutes":${value}}`;
      const response = await probe(server, '/api/notifications/send', body, mintToken({ org_id: teamId }));
      assert.strictEqual(response.status, 400, `dedupMinutes ${value} must be refused`);
      assert.strictEqual(dedupRowsForChannel(channelId).length, 0, `dedupMinutes ${value} must write no row`);
    }
  });

  it('answers 400 for a null window and writes no row', async function () {
    const channelId = seedChannel();
    const response = await probe(
      server,
      '/api/notifications/send',
      sendPayload(channelId, { dedupMinutes: null }),
      mintToken({ org_id: teamId }),
    );
    assert.strictEqual(response.status, 400);
    assert.strictEqual(dedupRowsForChannel(channelId).length, 0);
  });

  it('accepts a number, writes the suppression row and suppresses the matching follow-up send', async function () {
    const channelId = seedChannel();
    const response = await probe(
      server,
      '/api/notifications/send',
      sendPayload(channelId, { dedupMinutes: ACCEPTED_MINUTES }),
      mintToken({ org_id: teamId }),
    );
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);

    const suppressUntil = new Date(suppressUntilFor(channelId)).getTime();
    const expected = Date.now() + ACCEPTED_MINUTES * 60 * 1000;
    assert.ok(
      Math.abs(suppressUntil - expected) < 60 * 1000,
      `suppress_until must be ~${ACCEPTED_MINUTES} minutes ahead (got ${new Date(suppressUntil).toISOString()})`,
    );

    const followUp = await probe(server, '/api/notifications/send', sendPayload(channelId), mintToken({ org_id: teamId }));
    assert.strictEqual(followUp.status, 200);
    assert.strictEqual(followUp.body.success, false);
    assert.strictEqual(followUp.body.skipped, 'deduplicated');
  });

  it('keeps the default window when dedupMinutes is omitted', async function () {
    const channelId = seedChannel();
    const response = await probe(server, '/api/notifications/send', sendPayload(channelId), mintToken({ org_id: teamId }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.success, true);

    const suppressUntil = new Date(suppressUntilFor(channelId)).getTime();
    const expected = Date.now() + DEFAULT_WINDOW_MINUTES * 60 * 1000;
    assert.ok(
      Math.abs(suppressUntil - expected) < 60 * 1000,
      `suppress_until must be ~${DEFAULT_WINDOW_MINUTES} minutes ahead (got ${new Date(suppressUntil).toISOString()})`,
    );
  });

  it('refuses a foreign channel for a tenant-scoped caller and writes no row', async function () {
    const channelId = seedChannel(otherTeamId);
    const response = await probe(
      server,
      '/api/notifications/send',
      sendPayload(channelId, { dedupMinutes: ACCEPTED_MINUTES }),
      mintToken({ org_id: teamId }),
    );
    assert.strictEqual(response.status, 404);
    assert.strictEqual(dedupRowsForChannel(channelId).length, 0);
  });
});