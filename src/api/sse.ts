import { IncomingMessage, ServerResponse } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { AuthContext } from './auth';

export interface SSEClient {
  id: string;
  res: ServerResponse;
  connectedAt: Date;
  lastHeartbeat: Date;
  teamId: string | null;
}

export type SSEEventType = 
  | 'monitor_update'
  | 'incident_alert'
  | 'playbook_progress'
  | 'billing_event'
  | 'heartbeat'
  | 'connected'
  | 'disconnected';

export interface SSEEvent {
  id: string;
  type: SSEEventType;
  timestamp: string;
  data: any;
  teamId?: string | null;
}

const clients = new Map<string, SSEClient>();

export function addSSEClient(req: IncomingMessage, res: ServerResponse, teamId: string | null): string {
  const clientId = uuidv4();
  const client: SSEClient = {
    id: clientId,
    res,
    connectedAt: new Date(),
    lastHeartbeat: new Date(),
    teamId,
  };
  clients.set(clientId, client);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  res.write(`retry: 5000\n\n`);
  sendEvent(client, {
    id: uuidv4(),
    type: 'connected',
    timestamp: new Date().toISOString(),
    data: { clientId, message: 'Connected to Nightlamp realtime stream' },
  });

  req.on('close', () => {
    removeSSEClient(clientId);
  });

  return clientId;
}

export function removeSSEClient(clientId: string): boolean {
  const client = clients.get(clientId);
  if (client) {
    try {
      client.res.end();
    } catch { }
    clients.delete(clientId);
    return true;
  }
  return false;
}

export function getConnectedClients(): SSEClient[] {
  return Array.from(clients.values());
}

export function getClientCount(): number {
  return clients.size;
}

export function sendEvent(client: SSEClient, event: SSEEvent): boolean {
  try {
    const data = JSON.stringify(event.data);
    client.res.write(`id: ${event.id}\n`);
    client.res.write(`event: ${event.type}\n`);
    client.res.write(`data: ${data}\n\n`);
    client.lastHeartbeat = new Date();
    return true;
  } catch {
    removeSSEClient(client.id);
    return false;
  }
}

export function broadcastEvent(type: SSEEventType, data: any, teamId?: string | null): number {
  const event: SSEEvent = {
    id: uuidv4(),
    type,
    timestamp: new Date().toISOString(),
    data,
    teamId,
  };

  let sent = 0;
  for (const client of clients.values()) {
    // Only send to clients with matching teamId, or to admin clients (teamId === null for admin)
    // Events without teamId (global events) go to all clients
    if (!event.teamId || client.teamId === event.teamId || client.teamId === null) {
      if (sendEvent(client, event)) {
        sent++;
      }
    }
  }
  return sent;
}

export function broadcastHeartbeat(): number {
  return broadcastEvent('heartbeat', { timestamp: new Date().toISOString(), clientCount: clients.size });
}

export function notifyMonitorUpdate(monitor: any): number {
  return broadcastEvent('monitor_update', monitor, monitor?.teamId || null);
}

export function notifyIncidentAlert(incident: any): number {
  return broadcastEvent('incident_alert', incident, incident?.teamId || null);
}

export function notifyPlaybookProgress(progress: any): number {
  return broadcastEvent('playbook_progress', progress, progress?.teamId || null);
}

export function notifyBillingEvent(event: any): number {
  return broadcastEvent('billing_event', event, event?.teamId || null);
}

export function handleSSERequest(req: IncomingMessage, res: ServerResponse, db: Database, auth: AuthContext | null): boolean {
  try {
    const host = req.headers.host;
    if (!host) {
      return false;
    }
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/realtime' || path === '/api/realtime/') {
      // Require authentication for realtime stream
      if (!auth) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return true;
      }
      addSSEClient(req, res, auth.teamId);
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

const heartbeatTimer = setInterval(() => {
  broadcastHeartbeat();
}, 30000);

heartbeatTimer.unref();