import * as crypto from 'crypto';
import assert from 'assert';
import { Database } from 'sql.js';
import { clearJwksCache, verifyAccessTokenAsync } from '../api/auth';
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

// JWKS key helpers
function jwkFor(publicKey: crypto.KeyObject, kid: string): Record<string, unknown> {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { ...jwk, kid, alg: 'RS256', use: 'sig' };
}

describe('Clerk JWKS rotation fallback (NOC-375)', () => {
  let primary: ReturnType<typeof crypto.generateKeyPairSync>;
  let rotated: ReturnType<typeof crypto.generateKeyPairSync>;
  let originalEnv: Record<string, string | undefined>;
  let originalFetch: any;

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

    // Set up JWKS: primary key with kid-primary, rotated key with kid-rotated
    const primaryJwk = jwkFor(primary.publicKey, 'kid-primary');
    const rotatedJwk = jwkFor(rotated.publicKey, 'kid-rotated');
    const jwksKeys = [primaryJwk, rotatedJwk];

    delete process.env.CLERK_JWT_SECRET;
    delete process.env.CLERK_JWT_PUBLIC_KEY;
    process.env.CLERK_JWT_ISSUER = ISSUER;
    delete process.env.CLERK_JWT_AUDIENCE;

    globalThis.fetch = (async (url: any, init?: any) => {
      const href = String(url);
      if (href.endsWith('/.well-known/jwks.json')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: jwksKeys }),
        };
      }
      return originalFetch(url, init);
    }) as any;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete (process.env as any)[key];
      } else {
        (process.env as any)[key] = value;
      }
    }
    globalThis.fetch = originalFetch;
    clearJwksCache();
  });

  it('accepts an RS256 token whose key is published in the instance JWKS (primary key)', async () => {
    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    const claims = await verifyAccessTokenAsync(token);

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
  });

  it('rotated key via JWKS fallback (no public key configured)', async () => {
    // Token signed with rotated key, JWKS has both primary and rotated keys
    const token = rsToken({ iss: ISSUER }, rotated.privateKey, 'kid-rotated');

    const claims = await verifyAccessTokenAsync(token);

    assert.strictEqual(claims.sub, 'jwks-user');
    assert.strictEqual(claims.issuer, ISSUER);
  });

  it('prefers an explicitly configured public key over the JWKS', async () => {
    process.env.CLERK_JWT_PUBLIC_KEY = primary.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const token = rsToken({ iss: ISSUER }, primary.privateKey, 'kid-primary');

    const claims = await verifyAccessTokenAsync(token);

    assert.strictEqual(claims.sub, 'jwks-user');
  });

  it('keeps the HS256 secret path working without touching the network', async () => {
    process.env.CLERK_JWT_SECRET = TEST_JWT_SECRET;
    const header = { alg: 'HS256', typ: 'JWT' };
    const payload = { sub: 'hs-user', exp: Math.floor(Date.now() / 1000) + 3600, iss: ISSUER };
    const input = `${base64url(header)}.${base64url(payload)}`;
    const signature = crypto.createHmac('sha256', TEST_JWT_SECRET).update(input).digest('base64url');

    const claims = await verifyAccessTokenAsync(`${input}.${signature}`);

    assert.strictEqual(claims.sub, 'hs-user');
  });

  it('refuses invalid token', async () => {
    await assert.rejects(
      () => verifyAccessTokenAsync('invalid-token'),
      (err: any) => err instanceof Error && err.message === 'Invalid authentication token'
    );
  });
});