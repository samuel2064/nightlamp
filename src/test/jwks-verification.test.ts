import * as crypto from 'crypto';
import assert from 'assert';
import { Database } from 'sql.js';
import { Server } from 'http';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { ApiAuthError, authenticateRequestAsync, clearJwksCache, verifyAccessTokenAsync } from '../api/auth';
import { TEST_JWT_SECRET } from './setup';

const ISSUER = 'https://clerk.test-instance.accounts.dev';

function base64url(value: any): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function rsToken(claims: Record<string, unknown>, privateKey: crypto.KeyObject, kid: string): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const payload = { sub: 'jwks-user', exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  const input = `${base64url(header)}.${base64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function jwkFor(publicKey: crypto.KeyObject, kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

describe('Clerk JWKS verification (NOC-237)', () => {
  let primary: ReturnType<typeof crypto.generateKeyPairSync>;
  let rotated: ReturnType<typeof crypto.generateKeyPairSync>;
  let originalFetch: any;
  let originalEnv: Record<string, string | undefined>;
  let fetchCalls: string[];
  let jwksKeys: Record<string, unknown>[];

  before(() => {
    primary = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    rotated = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  });

  beforeEach(() => {
    originalEnv = {
      CLERK_JWT_SECRET: process.env.CLERK_JWT_SECRET,
      CLERK_JWT_PUBLIC_KEY: process.env.CLERK_JWT_PUBLIC_KEY,
      CLERK_JWT_ISSUER: process.env.CLERK_JWT_ISSUER,
      CLERK_JWT_AUDIENCE: process.env.CLERK_JWT_AUDIENCE,
    };
    delete process.env.CLERK_JWT_SECRET;
    delete process.env.CLERK_JWT_PUBLIC_KEY;
    process.env.CLERK_JWT_ISSUER = ISSUER;
    delete process.env.CLERK_JWT_AUDIENCE;

    fetchCalls = [];
    jwksKeys = [jwkFor(primary.publicKey, 'kid-primary')];
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const href = String(url);
      fetchCalls.push(href);
      if (href.endsWith('/.well-known/jwks.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: jwksKeys }),
        };
      }
      return originalFetch(url, init);
    }) as any;

    clearJwksCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        (process.env as any)[key] = value;
      }
    }
    clearJwksCache();
  });

  it('accepts an RS256 token whose key is published in the instance JWKS', async () => {
    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    const claims = await verifyAccessTokenAsync(token);

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].startsWith(`${ISSUER}/.well-known/jwks.json`));
  });

  it('caches the JWKS instead of fetching it on every request', async () => {
    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    await verifyAccessTokenAsync(token);
    await verifyAccessTokenAsync(token);
    await verifyAccessTokenAsync(token);

    assert.strictEqual(fetchCalls.length, 1);
  });

  it('does not refetch the JWKS on unknown-kid requests thanks to the negative cache', async () => {
    const token = rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated');

    // // 1. Unknown-`kid` token: 401 with one fetch (base-head acceptance)
    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
    assert.strictEqual(fetchCalls.length, 1);

    // // 2. Same unknown `kid` again: 401 with one fetch (negative entry active, zero fetches)
    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
    assert.strictEqual(fetchCalls.length, 1);

    // // 3. After clearing the negative cache and updating the JWKS key set,
    // the rotated token is accepted with two fetches total
    clearJwksCache();
    jwksKeys = [jwkFor(primary.publicKey, 'kid-primary'), jwkFor(rotated.publicKey, 'kid-rotated')];
    const claims = await verifyAccessTokenAsync(token);
    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(fetchCalls.length, 2);
  });

  it('refuses a token whose signature does not match the published key', async () => {
    const token = rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-primary');

    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
  });

  it('answers 401 when the JWKS cannot be reached', async () => {
    globalThis.fetch = (async () => {
      fetchCalls.push('jwks-unreachable');
      throw new Error('network down');
    }) as any;

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
  });

  it('answers 401 when the JWKS endpoint answers with an error status', async () => {
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as any;

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
  });

  it('refuses a JWKS-signed token whose issuer does not match the configured issuer', async () => {
    const token = rsToken({ iss: 'https://evil.example' }, primary.privateKey, 'kid-primary');

    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
  });

  it('validates the audience when one is configured', async () => {
    process.env.CLERK_JWT_AUDIENCE = 'nightlamp-api';

    await assert.rejects(
      () => verifyAccessTokenAsync(rsToken({ iss: ISSUER, aud: 'other-api' }, primary.privateKey, 'kid-primary')),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );

    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER, aud: 'nightlamp-api' }, primary.privateKey, 'kid-primary'));
    assert.strictEqual(claims.sub, 'jwks-user');
  });

  it('answers 503 only when no verification path is configured at all', async () => {
    delete process.env.CLERK_JWT_ISSUER;

    await assert.rejects(
      () => verifyAccessTokenAsync(rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary')),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 503 && err.code === 'AUTH_NOT_CONFIGURED'
    );
  });

  it('prefers an explicitly configured public key over the JWKS', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = primary.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary'));

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('keeps the HS256 secret path working without touching the network', async () => {
    process.env.CLERK_JWT_SECRET = TEST_JWT_SECRET;
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = { sub: 'hs-user', exp: Math.floor(Date.now() / 1000) + 3600, iss: ISSUER };
    const input = `${base64url(header)}.${base64url(payload)}`;
    const signature = crypto.createHmac('sha256', TEST_JWT_SECRET).update(input).digest('base64url');

    const claims = await verifyAccessTokenAsync(`${input}.${signature}`);

    assert.strictEqual(claims.sub, 'hs-user');
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('refuses an unsigned token without fetching the JWKS', async () => {
    const header = { alg: 'none', typ: 'JWT' };
    const payload = { sub: 'nobody', exp: Math.floor(Date.now() / 1000) + 3600, iss: ISSUER };

    await assert.rejects(
      () => verifyAccessTokenAsync(`${base64url(header)}.${base64url(payload)}.`),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
    assert.strictEqual(fetchCalls.length, 0);
  });

  describe('the running API', () => {
    let db: Database;
    let server: Server;
    let port: number;

    before(async () => {
      db = await createDatabase();
      server = startApiServer(db, { port: 0 });
      port = (server.address() as any).port;
    });

    after(() => {
      if (server) server.close();
      if (db) db.close();
    });

    it('accepts a JWKS-signed token on a protected route', async () => {
      const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { authorization: `Bearer ${token}` },
      });

      const body = await res.json() as any;
      assert.strictEqual(res.status, 403);
      assert.strictEqual(body.code, 'FORBIDDEN');
    });

    it('refuses a protected route without a token', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { authorization: '' },
      });

      assert.strictEqual(res.status, 401);
    });

    it('resolves the team and role for a JWKS-signed token', async () => {
      const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');
      const auth = await authenticateRequestAsync(db, { headers: { authorization: `Bearer ${token}` } } as any);

      assert.strictEqual(auth.userId.length > 0, true);
      assert.strictEqual(auth.role, null);
    });
  });
});
