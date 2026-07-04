import { IncomingMessage, ServerResponse } from 'http';
import * as crypto from 'crypto';

interface ClerkEvent {
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
  if (!secret) return true;
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

export function handleClerkWebhook(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.url !== '/api/webhooks/clerk' || req.method !== 'POST') return false;

  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    try {
      const svixId = req.headers['svix-id'] as string;
      const svixTimestamp = req.headers['svix-timestamp'] as string;
      const svixSignature = req.headers['svix-signature'] as string;
      const secret = process.env.CLERK_WEBHOOK_SECRET || '';

      if (!verifyClerkWebhook(body, svixId, svixTimestamp, svixSignature, secret)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid webhook signature' }));
        return;
      }

      const event: ClerkEvent = JSON.parse(body);
      handleClerkEvent(event);

      res.end(JSON.stringify({ received: true }));
    } catch (err: any) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return true;
}
