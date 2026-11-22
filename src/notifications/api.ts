import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { ChannelType, ChannelConfig } from '../alerting/channels';
import { processNotification, sendDirectNotification, getChannelType, getChannelConfig, checkRateLimit, logDelivery, markDelivered } from './service';
import { AuthContext } from '../api/auth';
import { rowBelongsToScope, scopedTenantFilter, requireChannelOwnership } from '../api/tenant';
import { isBlockedAddress, isBlockedHostname } from '../engine/outbound-safety';
import * as net from 'net';

function isBlockedHost(host: string): boolean {
  if (isBlockedHostname(host)) return true;
  if (net.isIP(host)) return isBlockedAddress(host);
  return false;
}

function isBlockedChannelDestination(type: string, config: Record<string, unknown>): boolean {
  if (type === 'slack-webhook') {
    let parsed: URL;
    try {
      parsed = new URL(String(config.webhookUrl || ''));
    } catch {
      return true;
    }
    return isBlockedHost(parsed.hostname);
  }

  if (type === 'in-app-websocket') {
    let parsed: URL;
    try {
      parsed = new URL(String(config.url || ''));
    } catch {
      return true;
    }
    return isBlockedHost(parsed.hostname);
  }

  if (type === 'email-smtp') {
    const host = String(config.smtpHost || '').trim().toLowerCase();
    if (!host) return true;
    return isBlockedHost(host);
  }

  return false;
}

export class NotificationApi {
  private validTypes: Set<string> = new Set(['slack-webhook', 'email-smtp', 'in-app-websocket']);

  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse, auth: AuthContext | null = null): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;
    const teamId = auth ? auth.teamId : null;
    const userId = auth ? auth.userId : '';

    const channelMatch = path.match(/^\/api\/notifications\/channels(?:\/([a-zA-Z0-9-]+))?$/);

    if (path === '/api/notifications/channels' || path === '/api/notifications/channels/') {
      if (req.method === 'GET') { this.handleListChannels(req, res, teamId, userId); return true; }
      if (req.method === 'POST') { this.handleCreateChannel(req, res, teamId, userId); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    if (channelMatch && channelMatch[1]) {
      const channelId = channelMatch[1];
      if (req.method === 'PATCH') { this.handleUpdateChannel(req, channelId, res, teamId, userId); return true; }
      if (req.method === 'DELETE') { this.handleDeleteChannel(channelId, res, teamId, userId); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    if ((path === '/api/notifications/send' || path === '/api/notifications/send/') && req.method === 'POST') {
      this.handleSendNotification(req, res, teamId, userId);
      return true;
    }

    if ((path === '/api/notifications/deliver' || path === '/api/notifications/deliver/') && req.method === 'POST') {
      this.handleMarkDelivered(req, res, teamId, userId);
      return true;
    }

    return false;
  }

  private handleListChannels(req: IncomingMessage, res: ServerResponse, teamId: string | null, userId: string): void {
    // The scope never widens to the owner-less bucket, so a caller without a
    // team membership and without a personal channel sees nothing rather than
    // another user's rows (finding 5), and a personal channel stays invisible to
    // other personal users.
    const channels = this.scopedChannels(teamId, userId);

    // A signed-in caller without a team membership and without a personally
    // owned channel has no scope to list. Answer 403 rather than an empty list,
    // so a caller who owns nothing is refused instead of told that nothing
    // exists anywhere.
    if (teamId === null && channels.length === 0) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Notification channels require an organization or a personal channel', code: 'FORBIDDEN' }));
      return;
    }

    res.end(JSON.stringify({ channels, count: channels.length }));
  }

  private scopedChannels(teamId: string | null, userId: string) {
    // The scope never widens to the owner-less bucket, so a caller without a
    // team membership and without a personal channel sees nothing rather than
    // another user's rows (NOC-303 finding 5).
    const scope = scopedTenantFilter('alert_channels', teamId, userId);
    const result = this.db.exec(
      `SELECT id, name, type, enabled, team_id, created_at, updated_at FROM alert_channels WHERE ${scope.clause} ORDER BY created_at DESC`,
      scope.params,
    );
    return result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      name: row[1],
      type: row[2],
      enabled: row[3] === 1,
      teamId: row[4],
      createdAt: row[5],
      updatedAt: row[6],
    })) : [];
  }

  private handleCreateChannel(req: IncomingMessage, res: ServerResponse, teamId: string | null, userId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, type, config } = JSON.parse(body);
        if (!name || !type || !config) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name, type, and config are required' }));
          return;
        }

        if (!this.validTypes.has(type)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `type must be one of: ${Array.from(this.validTypes).join(', ')}` }));
          return;
        }

        const mappedType = type === 'slack-webhook' ? 'slack' : type === 'email-smtp' ? 'email' : type;

        if (isBlockedChannelDestination(type, config)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'config must target a public destination' }));
          return;
        }

        const id = uuidv4();
        this.db.run(
          `INSERT INTO alert_channels (id, name, type, config, team_id, owner_id) VALUES (?, ?, ?, ?, ?, ?)`,
          [id, name, mappedType, JSON.stringify(config), teamId, userId || null]
        );

        res.end(JSON.stringify({ success: true, id, name, type, teamId }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleUpdateChannel(req: IncomingMessage, channelId: string, res: ServerResponse, teamId: string | null, userId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, config, enabled } = JSON.parse(body);
        const updates: string[] = [];
        const params: any[] = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (config !== undefined) { updates.push('config = ?'); params.push(JSON.stringify(config)); }
        if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }

        if (updates.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No fields to update' }));
          return;
        }

        updates.push("updated_at = datetime('now')");
        const scope = scopedTenantFilter('alert_channels', teamId, userId);
        // A caller that owns nothing has no write predicate, so the update
        // matches no row and is refused rather than silently succeeding.
        this.db.run(`UPDATE alert_channels SET ${updates.join(', ')} WHERE id = ? AND ${scope.clause}`, [...params, channelId, ...scope.params]);
        if (this.db.getRowsModified() === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Channel not found' }));
          return;
        }
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleDeleteChannel(channelId: string, res: ServerResponse, teamId: string | null, userId: string): void {
    // Shared referenced-channel delete guard: scope ownership + monitored app reference check
    const guard = requireChannelOwnership(this.db, channelId, teamId, userId);
    if (guard) {
      res.writeHead(guard.status);
      res.end(JSON.stringify({ error: guard.error, code: guard.code }));
      return;
    }
    this.db.run('DELETE FROM alert_rules WHERE channel_id = ?', [channelId]);
    this.db.run('DELETE FROM notification_deduplication WHERE channel_id = ?', [channelId]);
    this.db.run('DELETE FROM notification_rate_limits WHERE channel_id = ?', [channelId]);
    this.db.run('DELETE FROM alert_channels WHERE id = ?', [channelId]);
    res.end(JSON.stringify({ success: true }));
  }

  private handleSendNotification(req: IncomingMessage, res: ServerResponse, teamId: string | null, userId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        const { channelId, title, description, failureType, severity, checkId, eventId, dedupMinutes } = JSON.parse(body);

        if (!channelId || !title || !failureType || !severity) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'channelId, title, failureType, and severity are required' }));
          return;
        }

        // The send is authorized against the authenticated principal, never against
        // only a client-supplied channel id: the caller must either belong to the
        // channel's team or personally own the channel.
        const inScope = rowBelongsToScope(this.db, 'alert_channels', channelId, teamId, userId);
        if (!inScope) {
          if (teamId === null) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'A team membership is required to access this resource', code: 'FORBIDDEN' }));
            return;
          }
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Channel not found' }));
          return;
        }

        const channelType = getChannelType(this.db, channelId);
        const channelConfig = getChannelConfig(this.db, channelId);

        if (!channelType || !channelConfig) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Channel not found' }));
          return;
        }

        const payload = {
          title,
          description: description || '',
          failureType,
          severity,
          detectedAt: new Date().toISOString(),
          checkId,
          eventId,
        };

        const dedupWindow = Math.max(1, dedupMinutes || 5);
        const result = await processNotification(
          this.db,
          channelId,
          channelType,
          channelConfig,
          payload,
          dedupWindow
        );

        res.end(JSON.stringify({
          success: result.sent,
          logId: result.logId,
          skipped: result.skipped,
        }));
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleMarkDelivered(req: IncomingMessage, res: ServerResponse, teamId: string | null, userId: string): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { logId } = JSON.parse(body);
        if (!logId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'logId is required' }));
          return;
        }
        const scope = scopedTenantFilter('alert_channels', teamId, userId, false);
        const owned = this.db.exec(
          `SELECT al.id FROM alert_log al JOIN alert_channels c ON c.id = al.channel_id WHERE al.id = ? AND ${scope.clause.replace('alert_channels.', 'c.')}`,
          [logId, ...scope.params],
        );
        if (owned.length === 0 || owned[0].values.length === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Notification log not found' }));
          return;
        }
        markDelivered(this.db, logId);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
}
