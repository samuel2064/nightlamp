import * as crypto from 'crypto';
import assert from 'assert';
import { Database } from 'sql.js';
import { Server } from 'http';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { ApiAuthError, authenticateRequestAsync, clearJwksCache, verifyAccessTokenAsync } from '../api/auth';

const ISSUER = 'https://clerk.test-instance.accounts.dev';
const BROKEN_PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nnot-a-valid-key-material\n-----END PUBLIC KEY-----\n';

function base64url(value: any): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function rsToken(claims: Record<string, unknown>, privateKey: crypto.KeyObject, kid: string): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const payload = { sub: 'fallback-user', exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  const input = `${base64url(header)}.${base64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function jwkFor(publicKey: crypto.KeyObject, kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

describe('Unloadable CLERK_JWT_PUBLIC_KEY (NOC-263 regression)', () => {
  let primary: ReturnType<typeof crypto.generateKeyPairSync>;
  let originalFetch: any;
  let originalEnv: Record<string, string | undefined>;
  let fetchCalls: string[];
  let jwksKeys: Record<string, unknown>[];
  let jwksReachable: boolean;

  before(() => {
    primary = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
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
    jwksReachable = true;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      const href = String(url);
      if (href.endsWith('/.well-known/jwks.json')) {
        fetchCalls.push(href);
        if (!jwksReachable) {
          throw new Error('network down');
        }
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

  it('rejects the token with 401 instead of failing to load the configured key', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = BROKEN_PUBLIC_KEY;
    jwksReachable = false;

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    await assert.rejects(
      () => verifyAccessTokenAsync(token),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 401
    );
  });

  it('never surfaces an OpenSSL decoder error from the configured key', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = BROKEN_PUBLIC_KEY;
    jwksReachable = false;

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    let caught: any = null;
    try {
      await verifyAccessTokenAsync(token);
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ApiAuthError);
    assert.strictEqual(caught.statusCode, 401);
    assert.strictEqual(String(caught.message).includes('DECODER routines'), false);
  });

  it('ignores the unloadable key and verifies through the JWKS', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = BROKEN_PUBLIC_KEY;

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    const claims = await verifyAccessTokenAsync(token);

    assert.strictEqual(claims.sub, 'fallback-user');
    assert.strictEqual(fetchCalls.length, 1);
  });

  it('keeps a loadable configured key ahead of the JWKS', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = primary.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    const claims = await verifyAccessTokenAsync(token);

    assert.strictEqual(claims.sub, 'fallback-user');
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

    it('answers 401 and never 500 on a protected route with an unloadable configured key', async () => {
      process.env.CLERK_JWT_PUBLIC_KEY = BROKEN_PUBLIC_KEY;
      jwksReachable = false;
      clearJwksCache();

      const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.status, 401);
      const body = await res.text();
      assert.strictEqual(body.includes('DECODER routines'), false);
    });

    it('authenticates a protected route through the JWKS when the configured key is unloadable', async () => {
      process.env.CLERK_JWT_PUBLIC_KEY = BROKEN_PUBLIC_KEY;
      clearJwksCache();

      const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

      const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { authorization: `Bearer ${token}` },
      });

      assert.strictEqual(res.status, 200);
    });

    it('resolves the auth context through the JWKS when the configured key is unloadable', async () => {
      process.env.CLERK_JWT_PUBLIC_KEY = BROKEN_PUBLIC_KEY;
      clearJwksCache();

      const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');
      const auth = await authenticateRequestAsync(db, { headers: { authorization: `Bearer ${token}` } } as any);

      assert.strictEqual(auth.userId.length > 0, true);
    });
  });
});
