import { IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';
import { Database } from 'sql.js';

interface ClerkEvent {
  id: string;
  type: string;
  data: Record<string, any>;
  object: 'event';
}

function verifyClerkWebhook(
  body: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string
): boolean {
  if (!secret) return false;
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(signedContent)
    .digest('base64');
  const receivedSignatures = svixSignature.split(' ').map(s => s.trim());
  return receivedSignatures.some(sig => {
    const [version, sigValue] = sig.split(',');
    if (version !== 'v1') return false;
    try {
      return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(sigValue)
      );
    } catch {
      return false;
    }
  });
}

function isTimestampFresh(timestamp: string, maxAgeSeconds: number = 300): boolean {
  const timestampMs = parseInt(timestamp, 10) * 1000;
  const now = Date.now();
  return !isNaN(timestampMs) && Math.abs(now - timestampMs) <= maxAgeSeconds * 1000;
}

function initClerkWebhookTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS clerk_webhook_events (
      id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_clerk_webhook_events_received ON clerk_webhook_events(received_at)`);
}

function isReplay(db: Database, eventId: string): boolean {
  initClerkWebhookTable(db);
  const existing = db.exec('SELECT id FROM clerk_webhook_events WHERE id = ?', [eventId]);
  if (existing.length > 0 && existing[0].values.length > 0) {
    return true;
  }
  db.run('INSERT INTO clerk_webhook_events (id, received_at) VALUES (?, datetime("now"))', [eventId]);
  return false;
}

function handleClerkEvent(event: ClerkEvent): void {
  switch (event.type) {
    case 'user.created':
      console.log(`[Clerk] User created: ${event.data.id} (${event.data.email_addresses?.[0]?.email_address || 'no email'})`);
      break;
    case 'user.updated':
      console.log(`[Clerk] User updated: ${event.data.id}`);
      break;
    case 'user.deleted':
      console.log(`[Clerk] User deleted: ${event.data.id}`);
      break;
    case 'session.created':
      console.log(`[Clerk] Session created: ${event.data.id} for user ${event.data.user_id}`);
      break;
    case 'session.ended':
      console.log(`[Clerk] Session ended: ${event.data.id}`);
      break;
    case 'organization.created':
      console.log(`[Clerk] Organization created: ${event.data.id} - ${event.data.name}`);
      break;
    case 'organization.updated':
      console.log(`[Clerk] Organization updated: ${event.data.id}`);
      break;
    case 'organization.deleted':
      console.log(`[Clerk] Organization deleted: ${event.data.id}`);
      break;
    default:
      console.log(`[Clerk] Unhandled event type: ${event.type}`);
  }
}

export function handleClerkWebhook(req: IncomingMessage, res: ServerResponse, db: Database): boolean {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const path = parsedUrl.pathname;
  if ((path !== '/api/webhooks/clerk' && path !== '/api/webhooks/clerk/') || req.method !== 'POST') return false;

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const svixId = req.headers['svix-id'] as string;
      const svixTimestamp = req.headers['svix-timestamp'] as string;
      const svixSignature = req.headers['svix-signature'] as string;
      const secret = process.env.CLERK_WEBHOOK_SECRET || '';

      // Fail closed: require secret, signature, and timestamp
      if (!secret) {
        console.error('[Clerk Webhook] CLERK_WEBHOOK_SECRET not configured');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Webhook secret not configured' }));
        return;
      }
      if (!svixId || !svixTimestamp || !svixSignature) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Missing required Svix headers' }));
        return;
      }
      if (!verifyClerkWebhook(body, svixId, svixTimestamp, svixSignature, secret)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
        return;
      }
      if (!isTimestampFresh(svixTimestamp)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Webhook timestamp stale or invalid' }));
        return;
      }

      const event: ClerkEvent = JSON.parse(body);
      if (!event.id || typeof event.id !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing event id' }));
        return;
      }
      if (isReplay(db, event.id)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Duplicate event' }));
        return;
      }

      handleClerkEvent(event);

      res.end(JSON.stringify({ received: true }));
    } catch (err: any) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return true;
}