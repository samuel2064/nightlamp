import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export class TeamApi {
  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/teams' || path === '/api/teams/') {
      if (req.method === 'GET') { this.handleListTeams(res); return true; }
      if (req.method === 'POST') { this.handleCreateTeam(req, res); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const teamsMatch = path.match(/^\/api\/teams\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (teamsMatch) {
      const teamId = teamsMatch[1];
      const subPath = (teamsMatch[2] || '').replace(/\/+$/, '');

      if (!subPath) {
        if (req.method === 'GET') { this.handleGetTeam(teamId, res); return true; }
        if (req.method === 'PATCH') { this.handleUpdateTeam(req, teamId, res); return true; }
        if (req.method === 'DELETE') { this.handleDeleteTeam(teamId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/members') {
        if (req.method === 'GET') { this.handleListMembers(teamId, res); return true; }
        if (req.method === 'POST') { this.handleAddMember(req, teamId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      const memberMatch = subPath.match(/^\/members\/([a-zA-Z0-9-]+)$/);
      if (memberMatch) {
        const userId = memberMatch[1];
        if (req.method === 'PATCH') { this.handleUpdateMemberRole(req, teamId, userId, res); return true; }
        if (req.method === 'DELETE') { this.handleRemoveMember(teamId, userId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/workspace') {
        if (req.method === 'GET') { this.handleGetWorkspace(teamId, res); return true; }
        if (req.method === 'PATCH') { this.handleUpdateWorkspace(req, teamId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/invitations') {
        if (req.method === 'POST') { this.handleCreateInvitation(req, teamId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }

    const inviteMatch = path.match(/^\/api\/invitations\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (inviteMatch) {
      const token = inviteMatch[1];
      const subPath = (inviteMatch[2] || '').replace(/\/+$/, '');
      if (!subPath) {
        if (req.method === 'GET') { this.handleGetInvitation(token, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
      if (subPath === '/accept') {
        if (req.method === 'POST') { this.handleAcceptInvitation(req, token, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
    }

    return false;
  }

  private handleListTeams(res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, name, slug, owner_id, plan, created_at FROM teams ORDER BY created_at DESC'
    );
    const teams = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      name: row[1],
      slug: row[2],
      ownerId: row[3],
      plan: row[4],
      createdAt: row[5],
    })) : [];
    res.end(JSON.stringify({ teams, count: teams.length }));
  }

  private handleCreateTeam(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, slug, ownerId, plan } = JSON.parse(body);
        if (!name || !slug || !ownerId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name, slug, and ownerId are required' }));
          return;
        }
        const id = uuidv4();
        this.db.run(
          'INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
          [id, name, slug, ownerId, plan || 'free']
        );

        const workspaceId = uuidv4();
        this.db.run(
          'INSERT INTO team_workspaces (id, team_id) VALUES (?, ?)',
          [workspaceId, id]
        );

        const membershipId = uuidv4();
        this.db.run(
          'INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
          [membershipId, id, ownerId, 'owner']
        );

        res.end(JSON.stringify({ success: true, id, name, slug, ownerId, plan: plan || 'free' }));
      } catch (err: any) {
        if (err.message && err.message.includes('UNIQUE')) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'A team with this slug already exists' }));
          return;
        }
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleGetTeam(teamId: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, name, slug, owner_id, plan, created_at FROM teams WHERE id = ?',
      [teamId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Team not found' }));
      return;
    }
    const row = result[0].values[0];
    res.end(JSON.stringify({
      team: {
        id: row[0],
        name: row[1],
        slug: row[2],
        ownerId: row[3],
        plan: row[4],
        createdAt: row[5],
      },
    }));
  }

  private handleUpdateTeam(req: IncomingMessage, teamId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, slug, plan } = JSON.parse(body);
        const updates: string[] = [];
        const params: any[] = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (slug !== undefined) { updates.push('slug = ?'); params.push(slug); }
        if (plan !== undefined) { updates.push('plan = ?'); params.push(plan); }
        if (updates.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No fields to update' }));
          return;
        }
        this.db.run(`UPDATE teams SET ${updates.join(', ')} WHERE id = ?`, [...params, teamId]);
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        if (err.message && err.message.includes('UNIQUE')) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'A team with this slug already exists' }));
          return;
        }
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleDeleteTeam(teamId: string, res: ServerResponse): void {
    this.db.run('DELETE FROM memberships WHERE team_id = ?', [teamId]);
    this.db.run('DELETE FROM invitations WHERE team_id = ?', [teamId]);
    this.db.run('DELETE FROM team_workspaces WHERE team_id = ?', [teamId]);
    this.db.run('DELETE FROM teams WHERE id = ?', [teamId]);
    res.end(JSON.stringify({ success: true }));
  }

  private handleListMembers(teamId: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, team_id, user_id, role, invited_at FROM memberships WHERE team_id = ? ORDER BY invited_at ASC',
      [teamId]
    );
    const members = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      teamId: row[1],
      userId: row[2],
      role: row[3],
      invitedAt: row[4],
    })) : [];
    res.end(JSON.stringify({ members, count: members.length }));
  }

  private handleAddMember(req: IncomingMessage, teamId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { userId, role } = JSON.parse(body);
        if (!userId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'userId is required' }));
          return;
        }
        const memberRole = role || 'member';
        if (!['admin', 'member', 'owner'].includes(memberRole)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'role must be owner, admin, or member' }));
          return;
        }
        const teamExists = this.db.exec('SELECT id FROM teams WHERE id = ?', [teamId]);
        if (teamExists.length === 0 || teamExists[0].values.length === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Team not found' }));
          return;
        }
        const id = uuidv4();
        this.db.run(
          'INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
          [id, teamId, userId, memberRole]
        );
        res.end(JSON.stringify({ success: true, id, teamId, userId, role: memberRole }));
      } catch (err: any) {
        if (err.message && err.message.includes('UNIQUE')) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: 'User is already a member of this team' }));
          return;
        }
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleUpdateMemberRole(req: IncomingMessage, teamId: string, userId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { role } = JSON.parse(body);
        if (!role) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'role is required' }));
          return;
        }
        if (!['admin', 'member', 'owner'].includes(role)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'role must be owner, admin, or member' }));
          return;
        }
        this.db.run(
          'UPDATE memberships SET role = ? WHERE team_id = ? AND user_id = ?',
          [role, teamId, userId]
        );
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleRemoveMember(teamId: string, userId: string, res: ServerResponse): void {
    this.db.run('DELETE FROM memberships WHERE team_id = ? AND user_id = ?', [teamId, userId]);
    res.end(JSON.stringify({ success: true }));
  }

  private handleGetWorkspace(teamId: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, team_id, monitors, playbooks, alerts, settings, created_at, updated_at FROM team_workspaces WHERE team_id = ?',
      [teamId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      const wId = uuidv4();
      this.db.run('INSERT INTO team_workspaces (id, team_id) VALUES (?, ?)', [wId, teamId]);
      res.end(JSON.stringify({
        workspace: { id: wId, teamId, monitors: [], playbooks: [], alerts: [], settings: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      }));
      return;
    }
    const row = result[0].values[0];
    res.end(JSON.stringify({
      workspace: {
        id: row[0],
        teamId: row[1],
        monitors: JSON.parse(row[2] as string),
        playbooks: JSON.parse(row[3] as string),
        alerts: JSON.parse(row[4] as string),
        settings: JSON.parse(row[5] as string),
        createdAt: row[6],
        updatedAt: row[7],
      },
    }));
  }

  private handleUpdateWorkspace(req: IncomingMessage, teamId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { monitors, playbooks, alerts, settings } = JSON.parse(body);
        const updates: string[] = [];
        const params: any[] = [];
        if (monitors !== undefined) { updates.push('monitors = ?'); params.push(JSON.stringify(monitors)); }
        if (playbooks !== undefined) { updates.push('playbooks = ?'); params.push(JSON.stringify(playbooks)); }
        if (alerts !== undefined) { updates.push('alerts = ?'); params.push(JSON.stringify(alerts)); }
        if (settings !== undefined) { updates.push('settings = ?'); params.push(JSON.stringify(settings)); }
        if (updates.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No fields to update' }));
          return;
        }
        updates.push("updated_at = datetime('now')");
        this.db.run(
          `UPDATE team_workspaces SET ${updates.join(', ')} WHERE team_id = ?`,
          [...params, teamId]
        );
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleCreateInvitation(req: IncomingMessage, teamId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { email, role } = JSON.parse(body);
        if (!email) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'email is required' }));
          return;
        }
        const teamExists = this.db.exec('SELECT id FROM teams WHERE id = ?', [teamId]);
        if (teamExists.length === 0 || teamExists[0].values.length === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Team not found' }));
          return;
        }
        const id = uuidv4();
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
        this.db.run(
          'INSERT INTO invitations (id, team_id, email, role, token, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
          [id, teamId, email, role || 'member', token, expiresAt]
        );
        res.end(JSON.stringify({ success: true, id, teamId, email, role: role || 'member', token, expiresAt }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleGetInvitation(token: string, res: ServerResponse): void {
    const result = this.db.exec(
      `SELECT i.id, i.team_id, i.email, i.role, i.token, i.expires_at, t.name as team_name
       FROM invitations i JOIN teams t ON i.team_id = t.id WHERE i.token = ?`,
      [token]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Invitation not found' }));
      return;
    }
    const row = result[0].values[0];
    const expiresAt = row[5] as string;
    if (new Date(expiresAt) < new Date()) {
      res.writeHead(410);
      res.end(JSON.stringify({ error: 'Invitation has expired' }));
      return;
    }
    res.end(JSON.stringify({
      invitation: { id: row[0], teamId: row[1], email: row[2], role: row[3], token: row[4], expiresAt: row[5], teamName: row[6] },
    }));
  }

  private handleAcceptInvitation(req: IncomingMessage, token: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, team_id, email, role, expires_at FROM invitations WHERE token = ?',
      [token]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Invitation not found' }));
      return;
    }
    const row = result[0].values[0];
    const invitationId = row[0] as string;
    const teamId = row[1] as string;
    const userId = row[2] as string;
    const role = row[3] as string;
    const expiresAt = row[4] as string;

    if (new Date(expiresAt) < new Date()) {
      res.writeHead(410);
      res.end(JSON.stringify({ error: 'Invitation has expired' }));
      return;
    }

    const membershipId = uuidv4();
    this.db.run(
      'INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [membershipId, teamId, userId, role]
    );
    this.db.run('DELETE FROM invitations WHERE id = ?', [invitationId]);

    res.end(JSON.stringify({ success: true, teamId, userId, role }));
  }
}
