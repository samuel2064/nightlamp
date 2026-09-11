import { createDatabase } from '../db/schema';
import { startApiServer } from '../api/server';
import { Database } from 'sql.js';
import { Server } from 'http';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';

describe('Playbook Builder API', () => {
  let db: Database;
  let server: Server;
  let port: number;
  let teamId: string;

  before(async () => {
    db = await createDatabase();
    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'Test Team', 'test-team', 'user-1', 'free']);
    server = startApiServer(db, { port: 0 });
    const addr = server.address() as any;
    port = addr.port;
  });

  after(() => {
    if (server) server.close();
    if (db) db.close();
  });

  const api = (path: string, opts?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });

  describe('CRUD', () => {
    let playbookId: string;

    it('POST /api/playbooks/custom creates a playbook', async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'My Playbook', description: 'Test description' }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.name, 'My Playbook');
      assert.strictEqual(data.status, 'draft');
      assert.strictEqual(data.version, 1);
      playbookId = data.id;
    });

    it('POST /api/playbooks/custom requires teamId and name', async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ name: 'No team' }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('POST /api/playbooks/custom requires valid team', async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId: 'nonexistent', name: 'Bad' }),
      });
      assert.strictEqual(res.status, 404);
    });

    it('GET /api/playbooks/custom lists playbooks', async () => {
      const res = await api('/api/playbooks/custom');
      const data = await res.json() as any;
      assert.ok(data.count >= 1);
      assert.ok(data.playbooks.some((p: any) => p.name === 'My Playbook'));
    });

    it('GET /api/playbooks/custom/:id returns single playbook', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}`);
      const data = await res.json() as any;
      assert.strictEqual(data.playbook.name, 'My Playbook');
      assert.strictEqual(data.playbook.status, 'draft');
    });

    it('GET /api/playbooks/custom/:id returns 404 for unknown', async () => {
      const res = await api('/api/playbooks/custom/nonexistent');
      assert.strictEqual(res.status, 404);
    });

    it('PATCH /api/playbooks/custom/:id updates playbook', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Updated Playbook', description: 'Updated desc' }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);

      const getRes = await api(`/api/playbooks/custom/${playbookId}`);
      const getData = await getRes.json() as any;
      assert.strictEqual(getData.playbook.name, 'Updated Playbook');
      assert.strictEqual(getData.playbook.description, 'Updated desc');
    });

    it('PATCH /api/playbooks/custom/:id returns 400 for no fields', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}`, {
        method: 'PATCH',
        body: JSON.stringify({}),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('Node Graph', () => {
    let playbookId: string;
    let node1Id: string;
    let node2Id: string;

    before(async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'Graph Test' }),
      });
      const data = await res.json() as any;
      playbookId = data.id;
    });

    it('GET /api/playbooks/custom/:id/nodes returns empty graph', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`);
      const data = await res.json() as any;
      assert.strictEqual(data.nodeCount, 0);
      assert.strictEqual(data.edgeCount, 0);
    });

    it('PATCH /api/playbooks/custom/:id/nodes saves nodes and edges', async () => {
      node1Id = uuidv4();
      node2Id = uuidv4();
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [
            { id: node1Id, type: 'trigger', subtype: 'sentry_alert', config: { project: 'frontend' }, positionX: 100, positionY: 200 },
            { id: node2Id, type: 'action', subtype: 'retry_webhook', config: { url: 'https://example.com' }, positionX: 300, positionY: 200 },
          ],
          edges: [
            { id: uuidv4(), sourceNodeId: node1Id, targetNodeId: node2Id, sourcePort: 'out', targetPort: 'in' },
          ],
        }),
      });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.nodeCount, 2);
      assert.strictEqual(data.edgeCount, 1);
    });

    it('GET /api/playbooks/custom/:id/nodes returns saved graph', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`);
      const data = await res.json() as any;
      assert.strictEqual(data.nodeCount, 2);
      assert.strictEqual(data.edgeCount, 1);
      assert.ok(data.nodes.some((n: any) => n.subtype === 'sentry_alert'));
      assert.ok(data.nodes.some((n: any) => n.subtype === 'retry_webhook'));
    });

    it('PATCH rejects invalid node type', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [{ id: uuidv4(), type: 'invalid_type', subtype: 'whatever' }],
          edges: [],
        }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('PATCH rejects invalid subtype for node type', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [{ id: uuidv4(), type: 'trigger', subtype: 'invalid_subtype' }],
          edges: [],
        }),
      });
      assert.strictEqual(res.status, 400);
    });

    it('PATCH rejects cycles in node graph', async () => {
      const a = uuidv4();
      const b = uuidv4();
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [
            { id: a, type: 'trigger', subtype: 'sentry_alert' },
            { id: b, type: 'action', subtype: 'retry_webhook' },
          ],
          edges: [
            { id: uuidv4(), sourceNodeId: a, targetNodeId: b },
            { id: uuidv4(), sourceNodeId: b, targetNodeId: a },
          ],
        }),
      });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as any;
      assert.ok(data.error.includes('Cycle'));
    });

    it('PATCH rejects edge referencing unknown node', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [{ id: uuidv4(), type: 'trigger', subtype: 'sentry_alert' }],
          edges: [{ id: uuidv4(), sourceNodeId: 'unknown', targetNodeId: 'also_unknown' }],
        }),
      });
      assert.strictEqual(res.status, 400);
    });
  });

  describe('Publish', () => {
    let playbookId: string;

    before(async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'Publish Test' }),
      });
      const data = await res.json() as any;
      playbookId = data.id;

      const nodeId = uuidv4();
      await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [
            { id: nodeId, type: 'trigger', subtype: 'sentry_alert', config: { project: 'frontend' }, positionX: 100, positionY: 200 },
            { id: uuidv4(), type: 'action', subtype: 'retry_webhook', config: { url: 'https://example.com' }, positionX: 300, positionY: 200 },
          ],
          edges: [],
        }),
      });
    });

    it('POST /api/playbooks/custom/:id/publish publishes the playbook', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/publish`, { method: 'POST' });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.status, 'published');
      assert.strictEqual(data.version, 2);
    });

    it('published playbook shows published status', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}`);
      const data = await res.json() as any;
      assert.strictEqual(data.playbook.status, 'published');
      assert.strictEqual(data.playbook.version, 2);
    });

    it('publish bumps version each time', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/publish`, { method: 'POST' });
      const data = await res.json() as any;
      assert.strictEqual(data.version, 3);
    });

    it('rejects publish with no trigger node', async () => {
      const noTriggerId = (await (await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'No Trigger' }),
      })).json() as any).id;

      const nodeId = uuidv4();
      await api(`/api/playbooks/custom/${noTriggerId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [
            { id: nodeId, type: 'action', subtype: 'retry_webhook' },
          ],
          edges: [],
        }),
      });

      const res = await api(`/api/playbooks/custom/${noTriggerId}/publish`, { method: 'POST' });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as any;
      assert.ok(data.error.includes('trigger'));
    });

    it('rejects publish with no nodes', async () => {
      const emptyId = (await (await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'Empty' }),
      })).json() as any).id;

      const res = await api(`/api/playbooks/custom/${emptyId}/publish`, { method: 'POST' });
      assert.strictEqual(res.status, 400);
      const data = await res.json() as any;
      assert.ok(data.error.includes('no nodes'));
    });
  });

  describe('Versions', () => {
    let playbookId: string;

    before(async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'Version Test' }),
      });
      const data = await res.json() as any;
      playbookId = data.id;

      const nodeId = uuidv4();
      await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [
            { id: nodeId, type: 'trigger', subtype: 'sentry_alert' },
            { id: uuidv4(), type: 'action', subtype: 'retry_webhook' },
          ],
          edges: [],
        }),
      });

      await api(`/api/playbooks/custom/${playbookId}/publish`, { method: 'POST' });
    });

    it('GET /api/playbooks/custom/:id/versions lists versions', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/versions`);
      const data = await res.json() as any;
      assert.ok(data.count >= 2);
      assert.strictEqual(data.versions[0].version, 2);
    });

    it('GET /api/playbooks/custom/:id/versions/:versionId returns snapshot', async () => {
      const listRes = await api(`/api/playbooks/custom/${playbookId}/versions`);
      const listData = await listRes.json() as any;
      const latestVersionId = listData.versions[0].id;

      const res = await api(`/api/playbooks/custom/${playbookId}/versions/${latestVersionId}`);
      const data = await res.json() as any;
      assert.strictEqual(data.version.version, 2);
      assert.ok(Array.isArray(data.version.nodeSnapshot));
      assert.strictEqual(data.version.nodeSnapshot.length, 2);
    });

    it('GET returns 404 for unknown version', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}/versions/nonexistent`);
      assert.strictEqual(res.status, 404);
    });
  });

  describe('Delete', () => {
    let playbookId: string;

    before(async () => {
      const res = await api('/api/playbooks/custom', {
        method: 'POST',
        body: JSON.stringify({ teamId, name: 'Delete Test' }),
      });
      const data = await res.json() as any;
      playbookId = data.id;

      const nodeId = uuidv4();
      await api(`/api/playbooks/custom/${playbookId}/nodes`, {
        method: 'PATCH',
        body: JSON.stringify({
          nodes: [
            { id: nodeId, type: 'trigger', subtype: 'sentry_alert' },
            { id: uuidv4(), type: 'action', subtype: 'retry_webhook' },
          ],
          edges: [],
        }),
      });
    });

    it('DELETE /api/playbooks/custom/:id deletes playbook and associated data', async () => {
      const res = await api(`/api/playbooks/custom/${playbookId}`, { method: 'DELETE' });
      const data = await res.json() as any;
      assert.strictEqual(data.success, true);

      const getRes = await api(`/api/playbooks/custom/${playbookId}`);
      assert.strictEqual(getRes.status, 404);

      const nodesRes = await api(`/api/playbooks/custom/${playbookId}/nodes`);
      assert.strictEqual(nodesRes.status, 404);
    });
  });
});
