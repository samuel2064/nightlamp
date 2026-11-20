import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { Server } from 'http';
import { once } from 'events';
import { Database } from 'sql.js';
import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { createTestToken, fetchWithoutAuth } from './setup';

const FRONTEND_ROOT = path.join(process.cwd(), 'frontend', 'src');
const API_PATH_PATTERN = /\/api\/[A-Za-z0-9_\-/]*/g;

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

interface FrontendCall {
  file: string;
  route: string;
  method: 'GET' | 'POST';
}

function isUnknownRoute(payload: any): boolean {
  return Boolean(payload)
    && Array.isArray(payload.available)
    && payload.error === 'Not found';
}

/**
 * Collect every backend path the frontend calls.
 *
 * Only files that build their request URL from BACKEND_URL are inspected, so
 * the frontend's own routes (/api/trpc, /api/stream) are not included.
 */
function collectFrontendCalls(): FrontendCall[] {
  const calls: FrontendCall[] = [];
  for (const file of listSourceFiles(FRONTEND_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    if (!source.includes('BACKEND_URL')) continue;
    const relative = path.relative(process.cwd(), file);

    API_PATH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = API_PATH_PATTERN.exec(source)) !== null) {
      const literal = match[0];
      if (literal.length <= '/api/'.length) continue;

      const after = source.slice(match.index + literal.length);
      let route = literal.replace(/\/+$/, '');
      if (after.startsWith('${')) {
        const groupEnd = after.indexOf('}');
        const group = groupEnd === -1 ? '' : after.slice(0, groupEnd);
        route = group.includes('?')
          ? route
          : `${route}/probe-segment`;
      } else {
        route = route.split('?')[0];
      }

      const markerEnd = match.index + literal.length;
      let markerIndex = -1;
      let marker = '';
      for (const candidate of ['apiFetchPost', 'apiFetch', 'fetch(']) {
        const index = source.lastIndexOf(candidate, markerEnd);
        if (index > markerIndex) {
          markerIndex = index;
          marker = candidate;
        }
      }

      let isPost = false;
      if (markerIndex >= 0 && source.startsWith('apiFetchPost', markerIndex)) {
        isPost = true;
      } else if (marker === 'fetch(') {
        const tail = source.slice(markerEnd, markerEnd + 300);
        const nextCall = tail.indexOf('fetch(');
        const scope = nextCall === -1 ? tail : tail.slice(0, nextCall);
        isPost = /method:\s*['"]POST['"]/.test(scope);
      }

      calls.push({ file: relative, route, method: isPost ? 'POST' : 'GET' });
    }
  }
  return calls;
}

describe('frontend to backend route contract', () => {
  let db: Database;
  let server: Server;
  let port: number;
  const token = createTestToken({ sub: 'contract-user', email: 'contract-fixture-identity' });

  before(async () => {
    db = await createDatabase();
    server = startApiServer(db, {
      port: 0,
      stripeClient: { stripe: {}, priceIds: { basic: 'price_basic' } },
    });
    port = (server.address() as { port: number }).port;
  });

  after(async () => {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
    if (db) db.close();
  });

  it('finds backend calls in the frontend client', () => {
    const calls = collectFrontendCalls();
    assert.ok(calls.length > 0, 'expected the frontend to call the backend somewhere');
  });

  it('serves every backend route that the frontend calls', async () => {
    const calls = collectFrontendCalls();
    const missing: string[] = [];

    for (const call of calls) {
      const response = await fetchWithoutAuth(`http://127.0.0.1:${port}${call.route}`, {
        method: call.method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        ...(call.method === 'POST' ? { body: '{}' } : {}),
      });
      const body = await response.text();
      let payload: any = null;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = null;
      }
      if (isUnknownRoute(payload)) {
        missing.push(`${call.file} -> ${call.method} ${call.route}`);
      }
    }

    assert.deepStrictEqual(
      missing,
      [],
      `frontend calls backend routes that do not exist:\n${missing.join('\n')}`,
    );
  });
});
