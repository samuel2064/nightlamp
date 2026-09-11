import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import { ChannelType, ChannelConfig } from '../alerting/channels';
import { processNotification, sendDirectNotification, getChannelType, getChannelConfig, checkRateLimit, logDelivery, markDelivered } from './service';

export class NotificationApi {
  private validTypes: Set<string> = new Set(['slack-webhook', 'email-smtp', 'in-app-websocket']);

  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    const channelMatch = path.match(/^\/api\/notifications\/channels(?:\/([a-zA-Z0-9-]+))?$/);

    if (path === '/api/notifications/channels' || path === '/api/notifications/channels/') {
      if (req.method === 'GET') { this.handleListChannels(req, res); return true; }
      if (req.method === 'POST') { this.handleCreateChannel(req, res); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    if (channelMatch && channelMatch[1]) {
      const channelId = channelMatch[1];
      if (req.method === 'PATCH') { this.handleUpdateChannel(req, channelId, res); return true; }
      if (req.method === 'DELETE') { this.handleDeleteChannel(channelId, res); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    if ((path === '/api/notifications/send' || path === '/api/notifications/send/') && req.method === 'POST') {
      this.handleSendNotification(req, res);
      return true;
    }

    if ((path === '/api/notifications/deliver' || path === '/api/notifications/deliver/') && req.method === 'POST') {
      this.handleMarkDelivered(req, res);
      return true;
    }

    return false;
  }

  private handleListChannels(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const teamId = parsedUrl.searchParams.get('teamId');

    let sql = 'SELECT id, name, type, enabled, team_id, created_at, updated_at FROM alert_channels WHERE 1=1';
    const params: any[] = [];

    if (teamId) {
      sql += ' AND team_id = ?';
      params.push(teamId);
    }

    sql += ' ORDER BY created_at DESC';

    const result = this.db.exec(sql, params);
    const channels = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      name: row[1],
      type: row[2],
      enabled: row[3] === 1,
      teamId: row[4],
      createdAt: row[5],
      updatedAt: row[6],
    })) : [];

    res.end(JSON.stringify({ channels, count: channels.length }));
  }

  private handleCreateChannel(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, type, config, teamId } = JSON.parse(body);
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

        const id = uuidv4();
        this.db.run(
          `INSERT INTO alert_channels (id, name, type, config, team_id) VALUES (?, ?, ?, ?, ?)`,
          [id, name, mappedType, JSON.stringify(config), teamId || null]
        );

        res.end(JSON.stringify({ success: true, id, name, type, teamId: teamId || null }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleUpdateChannel(req: IncomingMessage, channelId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, config, enabled, teamId } = JSON.parse(body);
        const updates: string[] = [];
        const params: any[] = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (config !== undefined) { updates.push('config = ?'); params.push(JSON.stringify(config)); }
        if (enabled !== undefined) { updates.push('enabled = ?'); params.push(enabled ? 1 : 0); }
        if (teamId !== undefined) { updates.push('team_id = ?'); params.push(teamId); }

        if (updates.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No fields to update' }));
          return;
        }

        updates.push("updated_at = datetime('now')");
        this.db.run(`UPDATE alert_channels SET ${updates.join(', ')} WHERE id = ?`, [...params, channelId]);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleDeleteChannel(channelId: string, res: ServerResponse): void {
    this.db.run('DELETE FROM alert_rules WHERE channel_id = ?', [channelId]);
    this.db.run('DELETE FROM notification_deduplication WHERE channel_id = ?', [channelId]);
    this.db.run('DELETE FROM notification_rate_limits WHERE channel_id = ?', [channelId]);
    this.db.run('DELETE FROM alert_channels WHERE id = ?', [channelId]);
    res.end(JSON.stringify({ success: true }));
  }

  private handleSendNotification(req: IncomingMessage, res: ServerResponse): void {
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

        const result = await processNotification(
          this.db,
          channelId,
          channelType,
          channelConfig,
          payload,
          dedupMinutes || 5
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

  private handleMarkDelivered(req: IncomingMessage, res: ServerResponse): void {
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
        markDelivered(this.db, logId);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }
}
