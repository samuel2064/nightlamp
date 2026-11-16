import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';
import type { AuthContext } from '../api/auth';
import { tenantFilter } from '../api/tenant';

export type PlaybookNodeType = 'trigger' | 'condition' | 'action' | 'notification';
export type PlaybookStatus = 'draft' | 'published';

const VALID_NODE_TYPES: Set<string> = new Set(['trigger', 'condition', 'action', 'notification']);

const VALID_TRIGGERS: Set<string> = new Set(['sentry_alert', 'uptimerobot_check', 'dependency_update', 'schedule']);
const VALID_CONDITIONS: Set<string> = new Set(['severity_match', 'error_pattern', 'time_window', 'dependency_version']);
const VALID_ACTIONS: Set<string> = new Set(['retry_webhook', 'rate_limit_backoff', 'clear_cache', 'npm_update', 'rotate_token', 'restart_service']);
const VALID_NOTIFICATIONS: Set<string> = new Set(['slack', 'email', 'in_app', 'webhook']);

export interface PlaybookNode {
  id: string;
  playbookId: string;
  type: PlaybookNodeType;
  subtype: string;
  config: Record<string, unknown>;
  positionX: number;
  positionY: number;
  createdAt: string;
}

export interface PlaybookEdge {
  id: string;
  playbookId: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourcePort: string;
  targetPort: string;
  createdAt: string;
}

export interface CustomPlaybook {
  id: string;
  teamId: string;
  name: string;
  description: string;
  status: PlaybookStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookVersion {
  id: string;
  playbookId: string;
  version: number;
  name: string;
  description: string;
  nodeSnapshot: PlaybookNode[];
  edgeSnapshot: PlaybookEdge[];
  createdAt: string;
}

export class PlaybookBuilderApi {
  constructor(private db: Database) {}

  handle(req: IncomingMessage, res: ServerResponse, auth?: AuthContext | null): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;
    const teamId = auth ? auth.teamId : null;

    if (path === '/api/playbooks/custom' || path === '/api/playbooks/custom/') {
      if (req.method === 'GET') { this.handleListPlaybooks(res, teamId); return true; }
      if (req.method === 'POST') { this.handleCreatePlaybook(req, res, teamId); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const playbookMatch = path.match(/^\/api\/playbooks\/custom\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (playbookMatch) {
      const playbookId = playbookMatch[1];
      const subPath = (playbookMatch[2] || '').replace(/\/+$/, '');

      if (subPath === '/publish') {
        if (req.method === 'POST') { this.handlePublishPlaybook(playbookId, res, teamId); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/nodes') {
        if (req.method === 'GET') { this.handleGetNodes(playbookId, res, teamId); return true; }
        if (req.method === 'PATCH') { this.handleUpdateNodes(req, playbookId, res, teamId); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/versions') {
        if (req.method === 'GET') { this.handleListVersions(playbookId, res, teamId); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      const versionMatch = subPath.match(/^\/versions\/([a-zA-Z0-9-]+)$/);
      if (versionMatch) {
        const versionId = versionMatch[1];
        if (req.method === 'GET') { this.handleGetVersion(versionId, res, teamId); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (!subPath) {
        if (req.method === 'GET') { this.handleGetPlaybook(playbookId, res, teamId); return true; }
        if (req.method === 'PATCH') { this.handleUpdatePlaybook(req, playbookId, res, teamId); return true; }
        if (req.method === 'DELETE') { this.handleDeletePlaybook(playbookId, res, teamId); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return true;
    }

    return false;
  }

  private playbookScope(teamId: string | null): { clause: string; params: any[] } {
    return tenantFilter('team_id', teamId);
  }

  private findPlaybook(playbookId: string, teamId: string | null): any[] | null {
    const scope = this.playbookScope(teamId);
    const result = this.db.exec(
      `SELECT id, team_id, name, description, status, version, created_at, updated_at
       FROM custom_playbooks WHERE id = ? AND ${scope.clause}`,
      [playbookId, ...scope.params],
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    return result[0].values[0];
  }

  private handleListPlaybooks(res: ServerResponse, teamId: string | null): void {
    const scope = this.playbookScope(teamId);
    const result = this.db.exec(
      `SELECT id, team_id, name, description, status, version, created_at, updated_at
       FROM custom_playbooks WHERE ${scope.clause} ORDER BY updated_at DESC`,
      scope.params,
    );
    const playbooks = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      teamId: row[1],
      name: row[2],
      description: row[3],
      status: row[4],
      version: row[5],
      createdAt: row[6],
      updatedAt: row[7],
    })) : [];
    res.end(JSON.stringify({ playbooks, count: playbooks.length }));
  }

  private handleCreatePlaybook(req: IncomingMessage, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { teamId: requestedTeamId, name, description } = JSON.parse(body);
        if (!name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'name is required' }));
          return;
        }

        if (requestedTeamId && requestedTeamId !== teamId) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Cannot create a playbook for another organization' }));
          return;
        }

        if (teamId) {
          const teamExists = this.db.exec('SELECT id FROM teams WHERE id = ?', [teamId]);
          if (teamExists.length === 0 || teamExists[0].values.length === 0) {
            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Team not found' }));
            return;
          }
        }

        const id = uuidv4();
        this.db.run(
          'INSERT INTO custom_playbooks (id, team_id, name, description) VALUES (?, ?, ?, ?)',
          [id, teamId, name, description || '']
        );

        this.db.run(
          'INSERT INTO playbook_versions (id, playbook_id, version, name, description) VALUES (?, ?, ?, ?, ?)',
          [uuidv4(), id, 1, name, description || '']
        );

        res.end(JSON.stringify({ success: true, id, teamId, name, description: description || '', status: 'draft', version: 1 }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleGetPlaybook(playbookId: string, res: ServerResponse, teamId: string | null): void {
    const row = this.findPlaybook(playbookId, teamId);
    if (!row) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }
    res.end(JSON.stringify({
      playbook: {
        id: row[0],
        teamId: row[1],
        name: row[2],
        description: row[3],
        status: row[4],
        version: row[5],
        createdAt: row[6],
        updatedAt: row[7],
      },
    }));
  }

  private handleUpdatePlaybook(req: IncomingMessage, playbookId: string, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name, description } = JSON.parse(body);
        const updates: string[] = [];
        const params: any[] = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (description !== undefined) { updates.push('description = ?'); params.push(description); }

        if (updates.length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No fields to update' }));
          return;
        }

        if (!this.findPlaybook(playbookId, teamId)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Playbook not found' }));
          return;
        }

        const scope = this.playbookScope(teamId);
        updates.push("updated_at = datetime('now')");
        this.db.run(
          `UPDATE custom_playbooks SET ${updates.join(', ')} WHERE id = ? AND ${scope.clause}`,
          [...params, playbookId, ...scope.params]
        );
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleDeletePlaybook(playbookId: string, res: ServerResponse, teamId: string | null): void {
    if (!this.findPlaybook(playbookId, teamId)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }

    this.db.run('DELETE FROM playbook_versions WHERE playbook_id = ?', [playbookId]);
    this.db.run('DELETE FROM playbook_edges WHERE playbook_id = ?', [playbookId]);
    this.db.run('DELETE FROM playbook_nodes WHERE playbook_id = ?', [playbookId]);
    this.db.run('DELETE FROM custom_playbooks WHERE id = ?', [playbookId]);
    res.end(JSON.stringify({ success: true }));
  }

  private handlePublishPlaybook(playbookId: string, res: ServerResponse, teamId: string | null): void {
    const row = this.findPlaybook(playbookId, teamId);
    if (!row) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }
    const currentVersion = row[5] as number;
    const newVersion = currentVersion + 1;

    const nodes = this.getNodeList(playbookId);
    const edges = this.getEdgeList(playbookId);

    const cycle = this.detectCycle(nodes, edges);
    if (cycle) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: `Cycle detected in node graph involving node: ${cycle}` }));
      return;
    }

    if (nodes.length === 0) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Cannot publish a playbook with no nodes' }));
      return;
    }

    if (!nodes.some((n) => n.type === 'trigger')) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Playbook must have at least one trigger node' }));
      return;
    }

    const name = row[2] as string;
    const description = row[3] as string;

    this.db.run(
      'INSERT INTO playbook_versions (id, playbook_id, version, name, description, node_snapshot, edge_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), playbookId, newVersion, name, description, JSON.stringify(nodes), JSON.stringify(edges)]
    );

    this.db.run(
      "UPDATE custom_playbooks SET status = 'published', version = ?, updated_at = datetime('now') WHERE id = ?",
      [newVersion, playbookId]
    );

    res.end(JSON.stringify({ success: true, playbookId, version: newVersion, status: 'published' }));
  }

  private handleGetNodes(playbookId: string, res: ServerResponse, teamId: string | null): void {
    if (!this.findPlaybook(playbookId, teamId)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }

    const nodes = this.getNodeList(playbookId);
    const edges = this.getEdgeList(playbookId);

    res.end(JSON.stringify({ nodes, edges, nodeCount: nodes.length, edgeCount: edges.length }));
  }

  private handleUpdateNodes(req: IncomingMessage, playbookId: string, res: ServerResponse, teamId: string | null): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        if (!this.findPlaybook(playbookId, teamId)) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Playbook not found' }));
          return;
        }

        const { nodes, edges } = JSON.parse(body);

        if (!Array.isArray(nodes) || !Array.isArray(edges)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'nodes and edges arrays are required' }));
          return;
        }

        for (const node of nodes) {
          if (!VALID_NODE_TYPES.has(node.type)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Invalid node type: ${node.type}. Must be one of: ${Array.from(VALID_NODE_TYPES).join(', ')}` }));
            return;
          }

          if (!this.isValidSubtype(node.type, node.subtype)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Invalid subtype '${node.subtype}' for node type '${node.type}'` }));
            return;
          }
        }

        const nodeIds = new Set(nodes.map((n: any) => n.id));
        for (const edge of edges) {
          if (!nodeIds.has(edge.sourceNodeId)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Edge references unknown source node: ${edge.sourceNodeId}` }));
            return;
          }
          if (!nodeIds.has(edge.targetNodeId)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: `Edge references unknown target node: ${edge.targetNodeId}` }));
            return;
          }
        }

        const cycle = this.detectCycle(nodes, edges);
        if (cycle) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Cycle detected in node graph involving node: ${cycle}` }));
          return;
        }

        this.db.run('DELETE FROM playbook_edges WHERE playbook_id = ?', [playbookId]);
        this.db.run('DELETE FROM playbook_nodes WHERE playbook_id = ?', [playbookId]);

        for (const node of nodes) {
          this.db.run(
            'INSERT INTO playbook_nodes (id, playbook_id, type, subtype, config, position_x, position_y) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [node.id || uuidv4(), playbookId, node.type, node.subtype, JSON.stringify(node.config || {}), node.positionX || 0, node.positionY || 0]
          );
        }

        for (const edge of edges) {
          this.db.run(
            'INSERT INTO playbook_edges (id, playbook_id, source_node_id, target_node_id, source_port, target_port) VALUES (?, ?, ?, ?, ?, ?)',
            [edge.id || uuidv4(), playbookId, edge.sourceNodeId, edge.targetNodeId, edge.sourcePort || 'out', edge.targetPort || 'in']
          );
        }

        this.db.run("UPDATE custom_playbooks SET updated_at = datetime('now') WHERE id = ?", [playbookId]);

        res.end(JSON.stringify({ success: true, nodeCount: nodes.length, edgeCount: edges.length }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleListVersions(playbookId: string, res: ServerResponse, teamId: string | null): void {
    if (!this.findPlaybook(playbookId, teamId)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }

    const result = this.db.exec(
      'SELECT id, playbook_id, version, name, description, created_at FROM playbook_versions WHERE playbook_id = ? ORDER BY version DESC',
      [playbookId]
    );
    const versions = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      playbookId: row[1],
      version: row[2],
      name: row[3],
      description: row[4],
      createdAt: row[5],
    })) : [];
    res.end(JSON.stringify({ versions, count: versions.length }));
  }

  private handleGetVersion(versionId: string, res: ServerResponse, teamId: string | null): void {
    const scope = this.playbookScope(teamId);
    const result = this.db.exec(
      `SELECT pv.id, pv.playbook_id, pv.version, pv.name, pv.description, pv.node_snapshot, pv.edge_snapshot, pv.created_at
       FROM playbook_versions pv
       JOIN custom_playbooks cp ON cp.id = pv.playbook_id
       WHERE pv.id = ? AND cp.${scope.clause}`,
      [versionId, ...scope.params]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Version not found' }));
      return;
    }
    const row = result[0].values[0];
    res.end(JSON.stringify({
      version: {
        id: row[0],
        playbookId: row[1],
        version: row[2],
        name: row[3],
        description: row[4],
        nodeSnapshot: JSON.parse(row[5] as string),
        edgeSnapshot: JSON.parse(row[6] as string),
        createdAt: row[7],
      },
    }));
  }

  private getNodeList(playbookId: string): any[] {
    const result = this.db.exec(
      'SELECT id, playbook_id, type, subtype, config, position_x, position_y, created_at FROM playbook_nodes WHERE playbook_id = ? ORDER BY created_at ASC',
      [playbookId]
    );
    return result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      playbookId: row[1],
      type: row[2],
      subtype: row[3],
      config: JSON.parse(row[4] as string),
      positionX: row[5],
      positionY: row[6],
      createdAt: row[7],
    })) : [];
  }

  private getEdgeList(playbookId: string): any[] {
    const result = this.db.exec(
      'SELECT id, playbook_id, source_node_id, target_node_id, source_port, target_port, created_at FROM playbook_edges WHERE playbook_id = ? ORDER BY created_at ASC',
      [playbookId]
    );
    return result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0],
      playbookId: row[1],
      sourceNodeId: row[2],
      targetNodeId: row[3],
      sourcePort: row[4],
      targetPort: row[5],
      createdAt: row[6],
    })) : [];
  }

  private isValidSubtype(type: string, subtype: string): boolean {
    switch (type) {
      case 'trigger': return VALID_TRIGGERS.has(subtype);
      case 'condition': return VALID_CONDITIONS.has(subtype);
      case 'action': return VALID_ACTIONS.has(subtype);
      case 'notification': return VALID_NOTIFICATIONS.has(subtype);
      default: return false;
    }
  }

  private detectCycle(nodes: any[], edges: any[]): string | null {
    const adjacency = new Map<string, string[]>();
    for (const node of nodes) {
      adjacency.set(node.id, []);
    }
    for (const edge of edges) {
      const neighbors = adjacency.get(edge.sourceNodeId);
      if (neighbors) {
        neighbors.push(edge.targetNodeId);
      }
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    function dfs(nodeId: string): string | null {
      visited.add(nodeId);
      inStack.add(nodeId);

      const neighbors = adjacency.get(nodeId) || [];
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          const result = dfs(neighbor);
          if (result) return result;
        } else if (inStack.has(neighbor)) {
          return neighbor;
        }
      }

      inStack.delete(nodeId);
      return null;
    }

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        const result = dfs(node.id);
        if (result) return result;
      }
    }

    return null;
  }
}
