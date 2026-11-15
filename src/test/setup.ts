import * as crypto from 'crypto';

export const TEST_JWT_SECRET = 'nightlamp-test-jwt-secret';
export const TEST_CLERK_USER_ID = 'test-clerk-user';
export const TEST_LOCAL_USER_ID = 'user-1';

process.env.CLERK_JWT_SECRET = TEST_JWT_SECRET;

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function createTestToken(claims: Record<string, unknown> = {}, secret: string = TEST_JWT_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: TEST_CLERK_USER_ID,
    email: 'test@example.com',
    iat: now,
    exp: now + 3600,
    ...claims,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest('base64url');
  return `${signingInput}.${signature}`;
}

const unpatchedFetch = globalThis.fetch.bind(globalThis);

export function fetchWithoutAuth(input: any, init?: any): Promise<Response> {
  return unpatchedFetch(input, init);
}

const patchedFetch = async (input: any, init: any = {}): Promise<Response> => {
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url === 'string' && /127\.0\.0\.1|localhost/.test(url)) {
    const headers = new Headers(
      init?.headers || (typeof input === 'object' && input?.headers ? input.headers : undefined)
    );
    if (!headers.has('authorization')) {
      headers.set('authorization', `Bearer ${createTestToken()}`);
    }
    return unpatchedFetch(input, { ...init, headers });
  }
  return unpatchedFetch(input, init);
};

(globalThis as any).fetch = patchedFetch;
