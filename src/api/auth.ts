import * as crypto from 'crypto';
import { IncomingHttpHeaders, IncomingMessage } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';

export type TeamRole = 'owner' | 'admin' | 'member';

export interface AuthContext {
  userId: string;
  email: string;
  teamId: string | null;
  role: TeamRole | null;
  token: string;
}

export interface VerifiedTokenClaims {
  sub: string;
  exp: number;
  iat?: number;
  nbf?: number;
  email?: string;
  name?: string;
  orgId?: string;
  issuer?: string;
  audience?: string | string[];
}

export class ApiAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 401 | 403 | 503,
    public readonly code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'AUTH_NOT_CONFIGURED',
  ) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

interface JwtHeader {
  alg: string;
  typ?: string;
}

interface JwtVerificationConfig {
  secret?: string;
  publicKey?: string;
  issuer?: string;
  audience?: string;
}

function decodeJsonPart(value: string): Record<string, any> {
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid JSON');
    }
    return parsed;
  } catch {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }
}

function getVerificationConfig(): JwtVerificationConfig {
  const secret = process.env.CLERK_JWT_SECRET?.trim();
  const publicKey = process.env.CLERK_JWT_PUBLIC_KEY?.trim().replace(/\\n/g, '\n');
  if (!secret && !publicKey) {
    throw new ApiAuthError('Authentication is not configured', 503, 'AUTH_NOT_CONFIGURED');
  }
  return {
    secret: secret || undefined,
    publicKey: publicKey || undefined,
    issuer: process.env.CLERK_JWT_ISSUER?.trim() || undefined,
    audience: process.env.CLERK_JWT_AUDIENCE?.trim() || undefined,
  };
}

function verifyHs256(signingInput: string, signature: Buffer, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return signature.length === expected.length && crypto.timingSafeEqual(signature, expected);
}

function verifyRs256(signingInput: string, signature: Buffer, publicKey: string): boolean {
  return crypto.verify('RSA-SHA256', Buffer.from(signingInput), publicKey, signature);
}

function audienceMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
}

export function verifyAccessToken(token: string): VerifiedTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonPart(encodedHeader) as JwtHeader;
  const claims = decodeJsonPart(encodedPayload);
  const config = getVerificationConfig();
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  let signature: Buffer;
  try {
    signature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }

  let valid = false;
  if (header.alg === 'HS256' && config.secret) {
    valid = verifyHs256(signingInput, signature, config.secret);
  } else if (header.alg === 'RS256' && config.publicKey) {
    valid = verifyRs256(signingInput, signature, config.publicKey);
  }

  if (!valid) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }

  const now = Math.floor(Date.now() / 1000);
  const clockSkew = 30;
  if (typeof claims.exp !== 'number' || claims.exp + clockSkew <= now) {
    throw new ApiAuthError('Authentication token has expired', 401, 'UNAUTHORIZED');
  }
  if (typeof claims.nbf === 'number' && claims.nbf - clockSkew > now) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }
  if (typeof claims.iat === 'number' && claims.iat - clockSkew > now) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }
  if (typeof claims.sub !== 'string' || !claims.sub) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }
  if (config.issuer && claims.iss !== config.issuer) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }
  if (config.audience && !audienceMatches(claims.aud, config.audience)) {
    throw new ApiAuthError('Invalid authentication token', 401, 'UNAUTHORIZED');
  }

  const emailClaim = typeof claims.email === 'string'
    ? claims.email
    : Array.isArray(claims.email_addresses) && typeof claims.email_addresses[0]?.email_address === 'string'
      ? claims.email_addresses[0].email_address
      : undefined;
  const orgClaim = [claims.org_id, claims.orgId, claims.organization_id, claims.o]
    .find((value) => typeof value === 'string' && value);

  return {
    sub: claims.sub,
    exp: claims.exp,
    iat: typeof claims.iat === 'number' ? claims.iat : undefined,
    nbf: typeof claims.nbf === 'number' ? claims.nbf : undefined,
    email: emailClaim,
    name: typeof claims.name === 'string' ? claims.name : undefined,
    orgId: typeof orgClaim === 'string' ? orgClaim : undefined,
    issuer: typeof claims.iss === 'string' ? claims.iss : undefined,
    audience: claims.aud,
  };
}

export function extractBearerToken(headers: IncomingHttpHeaders): string | null {
  const authorization = headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value || !value.startsWith('Bearer ')) return null;
  const token = value.slice(7).trim();
  return token || null;
}

export function upsertUser(db: Database, claims: VerifiedTokenClaims): { id: string; email: string } {
  const existing = db.exec(
    'SELECT id, email FROM users WHERE clerk_user_id = ?',
    [claims.sub],
  );
  if (existing.length > 0 && existing[0].values.length > 0) {
    const id = existing[0].values[0][0] as string;
    const email = claims.email || existing[0].values[0][1] as string;
    if (claims.email) {
      db.run('UPDATE users SET email = ?, updated_at = datetime(\'now\') WHERE id = ?', [claims.email, id]);
    }
    return { id, email };
  }

  const id = uuidv4();
  const email = claims.email || `${claims.sub}@clerk.local`;
  db.run(
    'INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
    [id, claims.sub, email, claims.name || null],
  );
  return { id, email };
}

export function authenticateRequest(db: Database, req: IncomingMessage): AuthContext {
  const token = extractBearerToken(req.headers);
  if (!token) {
    throw new ApiAuthError('Authentication required', 401, 'UNAUTHORIZED');
  }

  const claims = verifyAccessToken(token);
  const user = upsertUser(db, claims);
  const memberships = db.exec(
    'SELECT team_id, role FROM memberships WHERE user_id = ? ORDER BY team_id',
    [user.id],
  );
  const available = memberships.length > 0
    ? memberships[0].values.map((row: any) => ({ teamId: row[0] as string, role: row[1] as TeamRole }))
    : [];

  const requestedTeam = claims.orgId || (() => {
    const header = req.headers['x-nightlamp-team-id'];
    const value = Array.isArray(header) ? header[0] : header;
    return typeof value === 'string' && value ? value : undefined;
  })();

  let membership = requestedTeam
    ? available.find((entry) => entry.teamId === requestedTeam)
    : available.length > 0
      ? available[0]
      : undefined;

  if (requestedTeam && !membership) {
    const team = db.exec('SELECT id FROM teams WHERE id = ? OR slug = ?', [requestedTeam, requestedTeam]);
    if (team.length > 0 && team[0].values.length > 0) {
      const teamId = team[0].values[0][0] as string;
      membership = available.find((entry) => entry.teamId === teamId);
    }
  }

  if (requestedTeam && !membership) {
    throw new ApiAuthError('Access to this organization is forbidden', 403, 'FORBIDDEN');
  }

  return {
    userId: user.id,
    email: user.email,
    teamId: membership ? membership.teamId : null,
    role: membership ? membership.role : null,
    token,
  };
}

export function getTeamRole(db: Database, userId: string, teamId: string): TeamRole | null {
  const result = db.exec(
    'SELECT role FROM memberships WHERE user_id = ? AND team_id = ?',
    [userId, teamId],
  );
  if (result.length === 0 || result[0].values.length === 0) return null;
  return result[0].values[0][0] as TeamRole;
}

export function assertTeamMembership(db: Database, userId: string, teamId: string): TeamRole {
  const role = getTeamRole(db, userId, teamId);
  if (role) return role;

  const owned = db.exec(
    'SELECT id FROM teams WHERE id = ? AND owner_id = ?',
    [teamId, userId],
  );
  if (owned.length > 0 && owned[0].values.length > 0) return 'owner';

  throw new ApiAuthError('Access to this organization is forbidden', 403, 'FORBIDDEN');
}

export function requireRole(auth: AuthContext, allowedRoles: TeamRole[]): void {
  if (!auth.role) {
    throw new ApiAuthError('This operation requires elevated permissions', 403, 'FORBIDDEN');
  }
  if (!allowedRoles.includes(auth.role)) {
    throw new ApiAuthError('This operation requires elevated permissions', 403, 'FORBIDDEN');
  }
}
