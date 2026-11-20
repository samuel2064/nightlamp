import { IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';

interface ClerkEvent {
  id: string;
  type: string;
  data: Record<string, any>;
  object: 'event';
}

function decodeSvixSecret(secret: string): Buffer {
  if (!secret.startsWith('whsec_')) {
    throw new Error('Invalid Svix secret format: must start with whsec_');
  }
  const base64Key = secret.slice(6);
  return Buffer.from(base64Key, 'base64');
}

function verifyClerkWebhook(
  body: string,
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  secret: string
): boolean {
  if (!secret) return false;
  const hmacKey = decodeSvixSecret(secret);
  const signedContent = `${svixId}.${svixTimestamp}.${body}`;
  const expectedSignature = crypto
    .createHmac('sha256', hmacKey)
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

async function isReplay(db: Database, eventId: string): Promise<boolean> {
  const result = db.exec(
    `SELECT id FROM clerk_webhook_events WHERE id = ?`,
    [eventId],
  );
  if (result.length > 0 && result[0].values.length > 0) {
    return true;
  }
  db.run(
    `INSERT INTO clerk_webhook_events (id, event_type, livemode, status, payload, received_at) VALUES (?, 'unknown', 0, 'received', '{}', datetime('now'))`,
    [eventId],
  );
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
  req.on('end', async () => {
    try {
      const svixId = req.headers['svix-id'] as string;
      const svixTimestamp = req.headers['svix-timestamp'] as string;
      const svixSignature = req.headers['svix-signature'] as string;
      const secret = process.env.CLERK_WEBHOOK_SECRET || '';

      if (!secret) {
        console.error('[Clerk Webhook] CLERK_WEBHOOK_SECRET not configured');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Webhook secret not configured', code: 'UNAUTHORIZED' }));
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
        event.id = uuidv4();
      }
      if (await isReplay(db, event.id)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Duplicate event' }));
        return;
      }

      handleClerkEvent(event);

      db.run(
        `UPDATE clerk_webhook_events SET event_type = ?, payload = ? WHERE id = ?`,
        [event.type, body, event.id],
      );

      res.end(JSON.stringify({ received: true }));
    } catch (err: any) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return true;
}