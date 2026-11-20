import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { ApiAuthError, AuthContext, TeamRole, assertTeamMembership } from '../api/auth';

const TEAM_ADMIN_ROLES: TeamRole[] = ['owner', 'admin'];

export class TeamApi {
  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse, auth?: AuthContext | null): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/teams' || path === '/api/teams/') {
      if (req.method === 'GET') { this.handleListTeams(res, auth); return true; }
      if (req.method === 'POST') { this.handleCreateTeam(req, res, auth); return true; }
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
        if (req.method === 'PATCH') { this.handleUpdateTeam(req, teamId, res, auth); return true; }
        if (req.method === 'DELETE') { this.handleDeleteTeam(teamId, res, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/members') {
        if (req.method === 'GET') { this.handleListMembers(teamId, res); return true; }
        if (req.method === 'POST') { this.handleAddMember(req, teamId, res, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      const memberMatch = subPath.match(/^\/members\/([a-zA-Z0-9-]+)$/);
      if (memberMatch) {
        const userId = memberMatch[1];
        if (req.method === 'PATCH') { this.handleUpdateMemberRole(req, teamId, userId, res, auth); return true; }
        if (req.method === 'DELETE') { this.handleRemoveMember(teamId, userId, res, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/workspace') {
        if (req.method === 'GET') { this.handleGetWorkspace(teamId, res); return true; }
        if (req.method === 'PATCH') { this.handleUpdateWorkspace(req, teamId, res, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/invitations') {
        if (req.method === 'POST') { this.handleCreateInvitation(req, teamId, res, auth); return true; }
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
        if (req.method === 'POST') { this.handleAcceptInvitation(req, token, res, auth); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }
    }

    return false;
  }

  private resolveTeamRole(auth: AuthContext | null | undefined, teamId: string): TeamRole | null {
    if (!auth) return null;
    try {
      return assertTeamMembership(this.db, auth.userId, teamId);
    } catch (err: any) {
      if (err instanceof ApiAuthError) return null;
      throw err;
    }
  }

  private requireTeamAdmin(auth: AuthContext | null | undefined, teamId: string, res: ServerResponse): TeamRole | null {
    const role = this.resolveTeamRole(auth, teamId);
    if (!role || !TEAM_ADMIN_ROLES.includes(role)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'This operation requires elevated permissions', code: 'FORBIDDEN' }));
      return null;
    }
    return role;
  }

  private isTeamOwner(auth: AuthContext | null | undefined, teamId: string): boolean {
    const owner = this.db.exec('SELECT owner_id FROM teams WHERE id = ?', [teamId]);
    if (owner.length === 0 || owner[0].values.length === 0) return false;
    return owner[0].values[0][0] === auth?.userId;
  }

  private handleListTeams(res: ServerResponse, auth?: AuthContext | null): void {
    const result = auth
      ? this.db.exec(
        `SELECT DISTINCT t.id, t.name, t.slug, t.owner_id, t.plan, t.created_at
         FROM teams t
         LEFT JOIN memberships m ON m.team_id = t.id AND m.user_id = ?
         WHERE t.owner_id = ? OR m.team_id IS NOT NULL
         ORDER BY t.created_at DESC`,
        [auth.userId, auth.userId]
      )
      : this.db.exec(
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

  private handleCreateTeam(req: IncomingMessage, res: ServerResponse, auth?: AuthContext | null): void {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, slug, ownerId: requestedOwnerId, plan } = JSON.parse(body);
        if (!name || !slug) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name and slug are required' }));
          return;
        }
        if (requestedOwnerId && requestedOwnerId !== auth.userId) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'You can only create a team that you own', code: 'FORBIDDEN' }));
          return;
        }
        const ownerId = auth.userId;
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

  private handleUpdateTeam(req: IncomingMessage, teamId: string, res: ServerResponse, auth?: AuthContext | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        if (!this.requireTeamAdmin(auth, teamId, res)) return;
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

  private handleDeleteTeam(teamId: string, res: ServerResponse, auth?: AuthContext | null): void {
    if (!this.requireTeamAdmin(auth, teamId, res)) return;
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

  private handleAddMember(req: IncomingMessage, teamId: string, res: ServerResponse, auth?: AuthContext | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        if (!this.requireTeamAdmin(auth, teamId, res)) return;
        const { userId, email, role } = JSON.parse(body);
        if (!userId && !email) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'userId or email is required' }));
          return;
        }
        const memberRole = role || 'member';
        if (!['admin', 'member', 'owner'].includes(memberRole)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'role must be owner, admin, or member' }));
          return;
        }
        if (memberRole === 'owner' && !this.isTeamOwner(auth, teamId)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Only the team owner can grant the owner role', code: 'FORBIDDEN' }));
          return;
        }
        const teamExists = this.db.exec('SELECT id FROM teams WHERE id = ?', [teamId]);
        if (teamExists.length === 0 || teamExists[0].values.length === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Team not found' }));
          return;
        }
        const resolvedUserId = this.resolveExistingUser(userId, email);
        if (!resolvedUserId) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'No account exists for that user', code: 'USER_NOT_FOUND' }));
          return;
        }
        const id = uuidv4();
        this.db.run(
          'INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
          [id, teamId, resolvedUserId, memberRole]
        );
        res.end(JSON.stringify({ success: true, id, teamId, userId: resolvedUserId, role: memberRole }));
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

  private resolveExistingUser(userId?: string, email?: string): string | null {
    if (userId) {
      const byId = this.db.exec('SELECT id FROM users WHERE id = ?', [userId]);
      if (byId.length > 0 && byId[0].values.length > 0) {
        return byId[0].values[0][0] as string;
      }
      if (!email) return null;
    }
    const normalizedEmail = String(email).trim().toLowerCase();
    const byEmail = this.db.exec('SELECT id FROM users WHERE LOWER(email) = ?', [normalizedEmail]);
    if (byEmail.length > 0 && byEmail[0].values.length > 0) {
      return byEmail[0].values[0][0] as string;
    }
    return null;
  }

  private handleUpdateMemberRole(req: IncomingMessage, teamId: string, userId: string, res: ServerResponse, auth?: AuthContext | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        if (!this.requireTeamAdmin(auth, teamId, res)) return;
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
        const existing = this.db.exec(
          'SELECT role FROM memberships WHERE team_id = ? AND user_id = ?',
          [teamId, userId]
        );
        if (existing.length === 0 || existing[0].values.length === 0) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Member not found' }));
          return;
        }
        const currentRole = existing[0].values[0][0];
        if ((role === 'owner' || currentRole === 'owner') && !this.isTeamOwner(auth, teamId)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Only the team owner can change the owner role', code: 'FORBIDDEN' }));
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

  private handleRemoveMember(teamId: string, userId: string, res: ServerResponse, auth?: AuthContext | null): void {
    if (!this.requireTeamAdmin(auth, teamId, res)) return;
    const existing = this.db.exec(
      'SELECT role FROM memberships WHERE team_id = ? AND user_id = ?',
      [teamId, userId]
    );
    if (existing.length === 0 || existing[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Member not found' }));
      return;
    }
    if (existing[0].values[0][0] === 'owner' && !this.isTeamOwner(auth, teamId)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Only the team owner can change the owner role', code: 'FORBIDDEN' }));
      return;
    }
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

  private handleUpdateWorkspace(req: IncomingMessage, teamId: string, res: ServerResponse, auth?: AuthContext | null): void {
    if (!this.requireTeamAdmin(auth, teamId, res)) return;
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

  private handleCreateInvitation(req: IncomingMessage, teamId: string, res: ServerResponse, auth?: AuthContext | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        if (!this.requireTeamAdmin(auth, teamId, res)) return;
        const { email, role } = JSON.parse(body);
        if (!email) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'email is required' }));
          return;
        }
        const inviteRole = role || 'member';
        if (!['admin', 'member', 'owner'].includes(inviteRole)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'role must be owner, admin, or member' }));
          return;
        }
        if (inviteRole === 'owner' && !this.isTeamOwner(auth, teamId)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Only the team owner can grant the owner role', code: 'FORBIDDEN' }));
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
          [id, teamId, email, inviteRole, token, expiresAt]
        );
        res.end(JSON.stringify({ success: true, id, teamId, email, role: inviteRole, token, expiresAt }));
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

  private handleAcceptInvitation(req: IncomingMessage, token: string, res: ServerResponse, auth?: AuthContext | null): void {
    if (!auth) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Authentication required' }));
      return;
    }
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
    const invitedEmail = String(row[2] as string).trim().toLowerCase();
    const role = row[3] as string;
    const expiresAt = row[4] as string;

    if (new Date(expiresAt) < new Date()) {
      res.writeHead(410);
      res.end(JSON.stringify({ error: 'Invitation has expired' }));
      return;
    }

    const account = this.db.exec('SELECT email FROM users WHERE id = ?', [auth.userId]);
    const accountEmail = account.length > 0 && account[0].values.length > 0
      ? String(account[0].values[0][0]).trim().toLowerCase()
      : '';
    const bothLookLikeEmails = accountEmail.includes('@') && invitedEmail.includes('@');
    if (bothLookLikeEmails && accountEmail !== invitedEmail) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'This invitation was issued to a different email address', code: 'FORBIDDEN' }));
      return;
    }

    const membershipId = uuidv4();
    this.db.run(
      'INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [membershipId, teamId, auth.userId, role]
    );
    this.db.run('DELETE FROM invitations WHERE id = ?', [invitationId]);

    res.end(JSON.stringify({ success: true, teamId, userId: auth.userId, role }));
  }
}
