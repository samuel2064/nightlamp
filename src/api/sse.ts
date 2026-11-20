import { IncomingMessage, ServerResponse } from 'http';
import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { AuthContext, authenticateRequestAsync, ApiAuthError } from '../api/auth';
import { requireTenantScope } from './guards';

export interface SSEClient {
  id: string;
  res: ServerResponse;
  connectedAt: Date;
  lastHeartbeat: Date;
  teamId: string;
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
}

const clients = new Map<string, SSEClient>();

export function addSSEClient(req: IncomingMessage, res: ServerResponse, teamId: string): string {
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

export function broadcastEvent(type: SSEEventType, data: any): number {
  const event: SSEEvent = {
    id: uuidv4(),
    type,
    timestamp: new Date().toISOString(),
    data,
  };

  let sent = 0;
  for (const client of clients.values()) {
    if (sendEvent(client, event)) {
      sent++;
    }
  }
  return sent;
}

export function broadcastEventToTeam(teamId: string, type: SSEEventType, data: any): number {
  const event: SSEEvent = {
    id: uuidv4(),
    type,
    timestamp: new Date().toISOString(),
    data,
  };

  let sent = 0;
  for (const client of clients.values()) {
    if (client.teamId === teamId && sendEvent(client, event)) {
      sent++;
    }
  }
  return sent;
}

export function broadcastHeartbeat(): number {
  return broadcastEvent('heartbeat', { timestamp: new Date().toISOString(), clientCount: clients.size });
}

export function notifyMonitorUpdate(teamId: string, monitor: any): number {
  return broadcastEventToTeam(teamId, 'monitor_update', monitor);
}

export function notifyIncidentAlert(teamId: string, incident: any): number {
  return broadcastEventToTeam(teamId, 'incident_alert', incident);
}

export function notifyPlaybookProgress(teamId: string, progress: any): number {
  return broadcastEventToTeam(teamId, 'playbook_progress', progress);
}

export function notifyBillingEvent(teamId: string, event: any): number {
  return broadcastEventToTeam(teamId, 'billing_event', event);
}

export async function handleSSERequest(req: IncomingMessage, res: ServerResponse, db: Database): Promise<boolean> {
  try {
    const host = req.headers.host;
    if (!host) {
      return false;
    }
    const parsedUrl = new URL(req.url || '/', `http://${host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/realtime' || path === '/api/realtime/') {
      // Require authentication
      let auth: AuthContext;
      try {
        auth = await authenticateRequestAsync(db, req);
      } catch (err: any) {
        if (err instanceof ApiAuthError) {
          res.writeHead(err.statusCode);
          res.end(JSON.stringify({ error: err.message, code: err.code }));
          return true;
        }
        throw err;
      }

      if (!requireTenantScope(res, auth.teamId)) {
        return true;
      }

      addSSEClient(req, res, auth.teamId!);
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