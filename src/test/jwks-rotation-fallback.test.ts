import * as crypto from 'crypto';
import assert from 'assert';
import { ApiAuthError, clearJwksCache, verifyAccessTokenAsync } from '../api/auth';
import { TEST_JWT_SECRET } from './setup';

const ISSUER = 'https://clerk.test-instance.accounts.dev';

function base64url(value: any): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function rsToken(
  claims: Record<string, unknown>,
  privateKey: crypto.KeyObject,
  kid?: string,
): string {
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' };
  if (kid !== undefined) header.kid = kid;
  const payload = { sub: 'jwks-user', exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  const input = `${base64url(header)}.${base64url(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

function jwkFor(publicKey: crypto.KeyObject, kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

function pemOf(publicKey: crypto.KeyObject): string {
  return publicKey.export({ type: 'spki', format: 'pem' }).toString();
}

async function expectUnauthorized(token: string): Promise<void> {
  await assert.rejects(
    () => verifyAccessTokenAsync(token),
    (err: any) => err instanceof ApiAuthError && err.statusCode === 401 && err.code === 'UNAUTHORIZED',
  );
}

describe('Clerk JWKS rotation fallback (NOC-375)', () => {
  let primary: crypto.KeyPair;
  let rotated: crypto.KeyPair;
  let originalEnv: Record<string, string | undefined>;
  let originalFetch: any;
  let fetchCalls: string[];
  let jwksKeys: Record<string, unknown>[];
  let jwksUnreachable: boolean;

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
    originalFetch = globalThis.fetch;

    fetchCalls = [];
    jwksKeys = [jwkFor(primary.publicKey, 'kid-primary'), jwkFor(rotated.publicKey, 'kid-rotated')];
    jwksUnreachable = false;

    delete process.env.CLERK_JWT_SECRET;
    delete process.env.CLERK_JWT_PUBLIC_KEY;
    process.env.CLERK_JWT_ISSUER = ISSUER;
    delete process.env.CLERK_JWT_AUDIENCE;

    globalThis.fetch = (async (url: any, init?: any) => {
      const href = String(url);
      fetchCalls.push(href);
      if (href.endsWith('/.well-known/jwks.json')) {
        if (jwksUnreachable) throw new Error('jwks unreachable');
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

  it('accepts an RS256 token whose key is published in the instance JWKS when nothing is pinned', async () => {
    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary'));

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].startsWith(`${ISSUER}/.well-known/jwks.json`));
  });

  it('accepts a token signed by the configured pinned key without fetching the JWKS', async () => {
    // The published key set deliberately omits the pinned kid, so reaching the
    // JWKS would fail this token: the case only passes if the pin is preferred.
    jwksKeys = [jwkFor(rotated.publicKey, 'kid-rotated')];
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);

    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary'));

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('accepts a rotated JWKS key when the configured pinned key is stale', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);

    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated'));

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
    assert.strictEqual(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].startsWith(`${ISSUER}/.well-known/jwks.json`));
  });

  it('survives a rotation where the cached key set is stale and only the new key is served', async () => {
    // Phase 1: no pin; the publisher currently serves the pre-rotation key only,
    // and the resolved key set is cached.
    jwksKeys = [jwkFor(primary.publicKey, 'kid-primary')];

    const pinned = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary'));
    assert.strictEqual(pinned.sub, 'jwks-user');
    assert.strictEqual(fetchCalls.length, 1);

    // Phase 2: the instance rotates. The publisher now serves only the new key,
    // while the configured pin still names the pre-rotation key.
    // With the negative cache enabled, the stale key is refetched once,
    // the rotated key is discovered, and authentication succeeds.
    jwksKeys = [jwkFor(rotated.publicKey, 'kid-rotated')];
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);

    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated'));

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
    // Exactly one bounded refetch of the stale cached key set, then the rotated
    // key is discovered and accepted. The negative entry is cleared because the
    // key set carries the kid.
    assert.strictEqual(fetchCalls.length, 2);
  });

  it('stays fail-closed 401 when the pinned key is stale and the JWKS is unreachable', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);
    jwksUnreachable = true;

    await expectUnauthorized(rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(fetchCalls.length, 1);
  });

  it('performs one bounded unknown-kid refetch and stays 401 when the key is absent', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);
    const token = rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-unknown');

    await expectUnauthorized(token);
    assert.strictEqual(fetchCalls.length, 1);

    // Second request with same unknown kid: negative cache should prevent
    // a refetch, staying 401 without additional network fetches.
    await expectUnauthorized(token);
    assert.strictEqual(fetchCalls.length, 1);

    // // 4a. A different unknown `kid` for the same issuer adds no additional fetch
    // (measured: one fetch total for two different unknown kids).
    const token2 = rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-unknown2');
    await expectUnauthorized(token2);
    assert.strictEqual(fetchCalls.length, 1);

    // // 4b. The rotated key is discovered again after `clearJwksCache()`
    // (measured: two fetches total and acceptance).
    clearJwksCache();
    jwksKeys = [jwkFor(primary.publicKey, 'kid-primary'), jwkFor(rotated.publicKey, 'kid-rotated')];
    const claims = await verifyAccessTokenAsync(rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(claims.sub, 'jwks-user');
  });

  it('still rejects a wrong issuer on the JWKS fallback path', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);

    await expectUnauthorized(rsToken({ iss: 'https://evil.example' }, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(fetchCalls.length, 1);
  });

  it('still rejects an expired token on the JWKS fallback path', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);
    const expired = { iss: ISSUER, exp: Math.floor(Date.now() / 1000) - 3600 };

    await expectUnauthorized(rsToken(expired, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(fetchCalls.length, 1);
  });

  it('still rejects a future not-before time on the JWKS fallback path', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);
    const future = { iss: ISSUER, nbf: Math.floor(Date.now() / 1000) + 3600 };

    await expectUnauthorized(rsToken(future, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(fetchCalls.length, 1);
  });

  it('still validates the audience on the JWKS fallback path when one is configured', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);
    process.env.CLERK_JWT_AUDIENCE = 'nightlamp-api';

    await expectUnauthorized(rsToken({ iss: ISSUER, aud: 'other-api' }, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(fetchCalls.length, 1);

    const claims = await verifyAccessTokenAsync(
      rsToken({ iss: ISSUER, aud: 'nightlamp-api' }, rotated.privateKey, 'kid-rotated'),
    );
    assert.strictEqual(claims.sub, 'jwks-user');
  });

  it('never fetches the JWKS when no issuer is configured', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);
    delete process.env.CLERK_JWT_ISSUER;

    await expectUnauthorized(rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated'));
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('never fetches the JWKS when the token carries no kid', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);

    await expectUnauthorized(rsToken({ iss: ISSUER }, rotated.privateKey, undefined));
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

  it('refuses a malformed token without touching the network', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = pemOf(primary.publicKey);

    await expectUnauthorized('invalid-token');
    assert.strictEqual(fetchCalls.length, 0);
  });

  it('answers 503 only when no verification path is configured at all', async () => {
    delete process.env.CLERK_JWT_ISSUER;

    await assert.rejects(
      () => verifyAccessTokenAsync(rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary')),
      (err: any) => err instanceof ApiAuthError && err.statusCode === 503 && err.code === 'AUTH_NOT_CONFIGURED',
    );
    assert.strictEqual(fetchCalls.length, 0);
  });
});
