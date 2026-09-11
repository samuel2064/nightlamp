import { Database } from 'sql.js';
import { IncomingMessage, ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';

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

  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = parsedUrl.pathname;

    if (path === '/api/playbooks/custom' || path === '/api/playbooks/custom/') {
      if (req.method === 'GET') { this.handleListPlaybooks(res); return true; }
      if (req.method === 'POST') { this.handleCreatePlaybook(req, res); return true; }
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    const playbookMatch = path.match(/^\/api\/playbooks\/custom\/([a-zA-Z0-9-]+)(\/.*)?$/);
    if (playbookMatch) {
      const playbookId = playbookMatch[1];
      const subPath = (playbookMatch[2] || '').replace(/\/+$/, '');

      if (subPath === '/publish') {
        if (req.method === 'POST') { this.handlePublishPlaybook(playbookId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/nodes') {
        if (req.method === 'GET') { this.handleGetNodes(playbookId, res); return true; }
        if (req.method === 'PATCH') { this.handleUpdateNodes(req, playbookId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (subPath === '/versions') {
        if (req.method === 'GET') { this.handleListVersions(playbookId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      const versionMatch = subPath.match(/^\/versions\/([a-zA-Z0-9-]+)$/);
      if (versionMatch) {
        const versionId = versionMatch[1];
        if (req.method === 'GET') { this.handleGetVersion(versionId, res); return true; }
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return true;
      }

      if (!subPath) {
        if (req.method === 'GET') { this.handleGetPlaybook(playbookId, res); return true; }
        if (req.method === 'PATCH') { this.handleUpdatePlaybook(req, playbookId, res); return true; }
        if (req.method === 'DELETE') { this.handleDeletePlaybook(playbookId, res); return true; }
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

  private handleListPlaybooks(res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, team_id, name, description, status, version, created_at, updated_at FROM custom_playbooks ORDER BY updated_at DESC'
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

  private handleCreatePlaybook(req: IncomingMessage, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { teamId, name, description } = JSON.parse(body);
        if (!teamId || !name) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'teamId and name are required' }));
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

  private handleGetPlaybook(playbookId: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, team_id, name, description, status, version, created_at, updated_at FROM custom_playbooks WHERE id = ?',
      [playbookId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }
    const row = result[0].values[0];
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

  private handleUpdatePlaybook(req: IncomingMessage, playbookId: string, res: ServerResponse): void {
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

        updates.push("updated_at = datetime('now')");
        this.db.run(
          `UPDATE custom_playbooks SET ${updates.join(', ')} WHERE id = ?`,
          [...params, playbookId]
        );
        res.end(JSON.stringify({ success: true }));
      } catch (err: any) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  }

  private handleDeletePlaybook(playbookId: string, res: ServerResponse): void {
    this.db.run('DELETE FROM playbook_versions WHERE playbook_id = ?', [playbookId]);
    this.db.run('DELETE FROM playbook_edges WHERE playbook_id = ?', [playbookId]);
    this.db.run('DELETE FROM playbook_nodes WHERE playbook_id = ?', [playbookId]);
    this.db.run('DELETE FROM custom_playbooks WHERE id = ?', [playbookId]);
    res.end(JSON.stringify({ success: true }));
  }

  private handlePublishPlaybook(playbookId: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, team_id, name, description, status, version FROM custom_playbooks WHERE id = ?',
      [playbookId]
    );
    if (result.length === 0 || result[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }

    const row = result[0].values[0];
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

  private handleGetNodes(playbookId: string, res: ServerResponse): void {
    const playbookResult = this.db.exec('SELECT id FROM custom_playbooks WHERE id = ?', [playbookId]);
    if (playbookResult.length === 0 || playbookResult[0].values.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Playbook not found' }));
      return;
    }

    const nodes = this.getNodeList(playbookId);
    const edges = this.getEdgeList(playbookId);

    res.end(JSON.stringify({ nodes, edges, nodeCount: nodes.length, edgeCount: edges.length }));
  }

  private handleUpdateNodes(req: IncomingMessage, playbookId: string, res: ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const playbookResult = this.db.exec('SELECT id FROM custom_playbooks WHERE id = ?', [playbookId]);
        if (playbookResult.length === 0 || playbookResult[0].values.length === 0) {
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

  private handleListVersions(playbookId: string, res: ServerResponse): void {
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

  private handleGetVersion(versionId: string, res: ServerResponse): void {
    const result = this.db.exec(
      'SELECT id, playbook_id, version, name, description, node_snapshot, edge_snapshot, created_at FROM playbook_versions WHERE id = ?',
      [versionId]
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
