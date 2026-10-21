import { createDatabase } from '../db/schema';
import { appRouter, createTRPCContext, UserInfo } from '../api/trpc';
import { PlaybookEngine, createPlaybookEngine } from '../playbook/engine';
import { Database } from 'sql.js';
import assert from 'assert';
import { v4 as uuidv4 } from 'uuid';

describe('Playbook tRPC Router', () => {
  let db: Database;
  let engine: PlaybookEngine;
  let caller: ReturnType<typeof appRouter.createCaller>;
  let teamId: string;
  let testUser: UserInfo;

  before(async () => {
    db = await createDatabase();
    engine = createPlaybookEngine(db);
    
    teamId = uuidv4();
    db.run('INSERT INTO teams (id, name, slug, owner_id, plan) VALUES (?, ?, ?, ?, ?)',
      [teamId, 'Test Team', 'test-team-trpc', 'user-1', 'free']);

    // Create test user
    const userId = uuidv4();
    db.run('INSERT INTO users (id, clerk_user_id, email, name) VALUES (?, ?, ?, ?)',
      [userId, 'test-clerk-id', 'test@example.com', 'Test User']);
    db.run('INSERT INTO memberships (id, team_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), teamId, userId, 'owner']);

    testUser = {
      id: userId,
      email: 'test@example.com',
      teamIds: [teamId],
    };

    const ctx = createTRPCContext(db, engine);
    ctx.user = testUser;
    caller = appRouter.createCaller(ctx);
  });

  after(() => {
    if (db) db.close();
  });

  const insertPlaybookIntoDb = async (overrides: any = {}): Promise<string> => {
    const uniquePlaybookId = uuidv4();
    const now = new Date().toISOString();
    const steps = overrides.steps || [
      {
        id: 'step-1',
        type: 'custom_code',
        name: 'Mock Health Check',
        config: { 
          code: 'return { status: 200, data: { success: true } };',
          language: 'javascript',
        },
        nextStepId: 'step-2',
      },
      {
        id: 'step-2',
        type: 'custom_code',
        name: 'Check OK',
        config: { 
          code: 'return { assertionResult: true };',
          language: 'javascript',
        },
      },
    ];
    const variables = overrides.variables || { baseUrl: 'https://httpbin.org' };

    db.run(
      `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, variables, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', 1, ?, ?, ?)`,
      [uniquePlaybookId, teamId, overrides.name || 'Test Playbook', overrides.description || '', JSON.stringify(variables), now, now]
    );

    const stepIdMap = new Map<string, string>();
    // First pass: generate all unique step IDs
    for (const step of steps) {
      const uniqueStepId = step.id + '-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
      stepIdMap.set(step.id, uniqueStepId);
    }

    // Second pass: create new steps with mapped IDs
    for (const step of steps) {
      const uniqueStepId = stepIdMap.get(step.id)!;
      let nodeType: 'trigger' | 'condition' | 'action' | 'notification';
      let subtype = step.type;
      switch (step.type) {
        case 'http_request': nodeType = 'action'; break;
        case 'assertion': nodeType = 'condition'; break;
        case 'wait': nodeType = 'action'; break;
        case 'conditional': nodeType = 'condition'; break;
        case 'notification': nodeType = 'notification'; break;
        case 'custom_code': nodeType = 'action'; subtype = 'custom_code'; break;
        default: nodeType = 'action';
      }

      db.run(
        `INSERT INTO playbook_nodes (id, playbook_id, type, subtype, config, position_x, position_y) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [uniqueStepId, uniquePlaybookId, nodeType, subtype, JSON.stringify(step.config), 0, 0]
      );
    }

    // Insert next edges
    for (let i = 0; i < steps.length - 1; i++) {
      if (steps[i].nextStepId) {
        const sourceId = stepIdMap.get(steps[i].id)!;
        const targetId = stepIdMap.get(steps[i].nextStepId!)!;
        db.run(
          `INSERT INTO playbook_edges (id, playbook_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, 'next')`,
          [uuidv4(), uniquePlaybookId, sourceId, targetId]
        );
      }
    }

    return uniquePlaybookId;
  };

  describe('playbook.listPlaybooks', () => {
    it('should list playbooks for team', async () => {
      await insertPlaybookIntoDb({ name: 'Playbook 1' });
      await insertPlaybookIntoDb({ name: 'Playbook 2' });

      const result = await caller.playbook.listPlaybooks({ teamId });
      assert.ok(result.playbooks.length >= 2);
      assert.ok(result.playbooks.some(p => p.name === 'Playbook 1'));
      assert.ok(result.playbooks.some(p => p.name === 'Playbook 2'));
      assert.strictEqual(result.count, result.playbooks.length);
    });

    it('should return playbooks ordered by updated_at desc', async () => {
      const result = await caller.playbook.listPlaybooks({ teamId });
      for (let i = 1; i < result.playbooks.length; i++) {
        assert.ok(new Date(result.playbooks[i-1].updatedAt) >= new Date(result.playbooks[i].updatedAt));
      }
    });
  });

  describe('playbook.getPlaybook', () => {
    it('should return playbook by id', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Specific Playbook', description: 'Test desc' });

      const result = await caller.playbook.getPlaybook({ id });
      assert.strictEqual(result.playbook.id, id);
      assert.strictEqual(result.playbook.name, 'Specific Playbook');
      assert.strictEqual(result.playbook.description, 'Test desc');
      assert.strictEqual(result.playbook.status, 'published');
      assert.strictEqual(result.playbook.version, 1);
    });

    it('should throw NOT_FOUND for unknown playbook', async () => {
      try {
        await caller.playbook.getPlaybook({ id: 'nonexistent' });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.strictEqual(err.code, 'NOT_FOUND');
      }
    });
  });

  describe('playbook.createPlaybook', () => {
    it('should create a new playbook in draft status', async () => {
      const result = await caller.playbook.createPlaybook({
        teamId,
        name: 'New Playbook',
        description: 'Created via tRPC',
      });

      assert.ok(result.playbook.id);
      assert.strictEqual(result.playbook.teamId, teamId);
      assert.strictEqual(result.playbook.name, 'New Playbook');
      assert.strictEqual(result.playbook.description, 'Created via tRPC');
      assert.strictEqual(result.playbook.status, 'draft');
      assert.strictEqual(result.playbook.version, 1);
      assert.ok(result.playbook.createdAt);
    });

    it('should create playbook without description', async () => {
      const result = await caller.playbook.createPlaybook({
        teamId,
        name: 'No Description',
      });

      assert.strictEqual(result.playbook.description, '');
    });
  });

  describe('playbook.updatePlaybook', () => {
    it('should update playbook name and description', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Original', description: 'Original desc' });

      const result = await caller.playbook.updatePlaybook({
        id,
        name: 'Updated',
        description: 'Updated desc',
      });

      assert.strictEqual(result.playbook.id, id);
      assert.strictEqual(result.playbook.name, 'Updated');
      assert.strictEqual(result.playbook.description, 'Updated desc');
      assert.strictEqual(result.playbook.version, 2);
    });

    it('should update playbook status to published', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Draft Playbook' });

      const result = await caller.playbook.updatePlaybook({
        id,
        status: 'published',
      });

      assert.strictEqual(result.playbook.status, 'published');
      assert.strictEqual(result.playbook.version, 2);
    });

    it('should return 400 when no fields provided', async () => {
      const id = await insertPlaybookIntoDb();

      try {
        await caller.playbook.updatePlaybook({ id });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.strictEqual(err.code, 'BAD_REQUEST');
      }
    });
  });

  describe('playbook.deletePlaybook', () => {
    it('should delete playbook and associated data', async () => {
      const id = await insertPlaybookIntoDb({ name: 'To Delete' });

      const result = await caller.playbook.deletePlaybook({ id });
      assert.strictEqual(result.success, true);

      try {
        await caller.playbook.getPlaybook({ id });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.strictEqual(err.code, 'NOT_FOUND');
      }
    });
  });

  describe('playbook.createExecution', () => {
    it('should create and start execution', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Execution Test' });

      const result = await caller.playbook.createExecution({
        playbookId: id,
        context: { customVar: 'test-value' },
      });

      assert.ok(result.execution);
      assert.strictEqual(result.execution.playbookId, id);
      assert.strictEqual(result.execution.status, 'completed');
      assert.ok(result.execution.id);
      assert.ok(result.execution.context.customVar === 'test-value');
      assert.ok(result.execution.context.baseUrl === 'https://httpbin.org');
    });

    it('should throw NOT_FOUND for unknown playbook', async () => {
      try {
        await caller.playbook.createExecution({ playbookId: 'nonexistent' });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.strictEqual(err.code, 'NOT_FOUND');
      }
    });

    it('should create execution with empty context', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Empty Context Test' });

      const result = await caller.playbook.createExecution({ playbookId: id });
      assert.ok(result.execution);
      assert.strictEqual(result.execution.status, 'completed');
    });
  });

  describe('playbook.getExecution', () => {
    it('should return execution by id', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Get Execution Test' });
      const createResult = await caller.playbook.createExecution({ playbookId: id });

      const result = await caller.playbook.getExecution({ id: createResult.execution.id });
      assert.strictEqual(result.execution.id, createResult.execution.id);
      assert.strictEqual(result.execution.playbookId, id);
    });

    it('should throw NOT_FOUND for unknown execution', async () => {
      try {
        await caller.playbook.getExecution({ id: 'nonexistent' });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.strictEqual(err.code, 'NOT_FOUND');
      }
    });
  });

  describe('playbook.listExecutions', () => {
    it('should list all executions', async () => {
      const id = await insertPlaybookIntoDb({ name: 'List Executions Test' });
      await caller.playbook.createExecution({ playbookId: id });
      await caller.playbook.createExecution({ playbookId: id });

      const result = await caller.playbook.listExecutions({ playbookId: id });
      assert.ok(result.executions.length >= 2);
      assert.strictEqual(result.count, result.executions.length);
    });

    it('should filter by playbookId', async () => {
      const id1 = await insertPlaybookIntoDb({ name: 'Playbook A' });
      const id2 = await insertPlaybookIntoDb({ name: 'Playbook B' });
      await caller.playbook.createExecution({ playbookId: id1 });
      await caller.playbook.createExecution({ playbookId: id2 });

      const result = await caller.playbook.listExecutions({ playbookId: id1 });
      assert.ok(result.executions.every(e => e.playbookId === id1));
    });

    it('should return executions ordered by createdAt desc', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Order Test' });
      await caller.playbook.createExecution({ playbookId: id });
      await new Promise(r => setTimeout(r, 10));
      await caller.playbook.createExecution({ playbookId: id });

      const result = await caller.playbook.listExecutions({ playbookId: id });
      for (let i = 1; i < result.executions.length; i++) {
        assert.ok(new Date(result.executions[i-1].createdAt) >= new Date(result.executions[i].createdAt));
      }
    });
  });

  describe('playbook.provideDecision', () => {
    it('should resume execution after decision', async () => {
      const decisionPlaybookId = uuidv4();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', 1, ?, ?)`,
        [
          decisionPlaybookId,
          teamId,
          'Decision Playbook',
          '',
          now,
          now,
        ]
      );

      db.run(
        `INSERT INTO playbook_nodes (id, playbook_id, type, subtype, config, position_x, position_y) VALUES (?, ?, 'action', 'custom_code', ?, ?, ?)`,
        ['decision-step', decisionPlaybookId, JSON.stringify({ code: 'return { requiresDecision: true, decisionOptions: ["yes", "no"] };' }), 0, 0]
      );
      db.run(
        `INSERT INTO playbook_nodes (id, playbook_id, type, subtype, config, position_x, position_y) VALUES (?, ?, 'notification', 'notification', ?, ?, ?)`,
        ['after-decision', decisionPlaybookId, JSON.stringify({ channel: 'test', message: 'Done' }), 100, 0]
      );
      db.run(
        `INSERT INTO playbook_edges (id, playbook_id, source_node_id, target_node_id) VALUES (?, ?, ?, ?)`,
        [uuidv4(), decisionPlaybookId, 'decision-step', 'after-decision']
      );

      const createResult = await caller.playbook.createExecution({ playbookId: decisionPlaybookId });
      const executionId = createResult.execution.id;

      const decisionResult = await caller.playbook.provideDecision({
        executionId,
        decision: 'yes',
      });

      assert.strictEqual(decisionResult.execution.id, executionId);
      assert.strictEqual(decisionResult.execution.status, 'completed');
      assert.strictEqual(decisionResult.execution.context.decision, 'yes');
    });

    it('should throw when execution not waiting for decision', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Not Waiting Test' });
      const createResult = await caller.playbook.createExecution({ playbookId: id });

      try {
        await caller.playbook.provideDecision({
          executionId: createResult.execution.id,
          decision: 'yes',
        });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.includes('not waiting for decision'));
      }
    });

    it('should throw NOT_FOUND for unknown execution', async () => {
      try {
        await caller.playbook.provideDecision({
          executionId: 'nonexistent',
          decision: 'yes',
        });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.strictEqual(err.code, 'NOT_FOUND');
      }
    });
  });

  describe('playbook.cancelExecution', () => {
    it('should cancel running execution', async () => {
      const longPlaybookId = uuidv4();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO custom_playbooks (id, team_id, name, description, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, 'published', 1, ?, ?)`,
        [
          longPlaybookId,
          teamId,
          'Long Playbook',
          '',
          now,
          now,
        ]
      );

      db.run(
        `INSERT INTO playbook_nodes (id, playbook_id, type, subtype, config, position_x, position_y) VALUES (?, ?, 'action', 'wait', ?, ?, ?)`,
        ['long-wait', longPlaybookId, JSON.stringify({ durationMs: 60000 }), 0, 0]
      );

      const createResult = await caller.playbook.createExecution({ playbookId: longPlaybookId });
      const executionId = createResult.execution.id;

      const result = await caller.playbook.cancelExecution({ executionId });
      assert.strictEqual(result.execution.id, executionId);
      assert.strictEqual(result.execution.status, 'cancelled');
      assert.ok(result.execution.completedAt);
    });

    it('should throw when cancelling completed execution', async () => {
      const id = await insertPlaybookIntoDb({ name: 'Cancel Completed Test' });
      const createResult = await caller.playbook.createExecution({ playbookId: id });

      try {
        await caller.playbook.cancelExecution({ executionId: createResult.execution.id });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.message.includes('Cannot cancel execution in status'));
      }
    });
  });

  describe('Type Safety', () => {
    it('should enforce input validation for createExecution', async () => {
      try {
        await (caller.playbook.createExecution as any)({ playbookId: 123 });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.code === 'BAD_REQUEST' || err.message.includes('playbookId'));
      }
    });

    it('should enforce input validation for provideDecision', async () => {
      try {
        await (caller.playbook.provideDecision as any)({ executionId: 'test', decision: 123 });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.code === 'BAD_REQUEST' || err.message.includes('decision'));
      }
    });

    it('should enforce input validation for createPlaybook', async () => {
      try {
        await (caller.playbook.createPlaybook as any)({ teamId: 123, name: 'Test' });
        assert.fail('Should have thrown');
      } catch (err: any) {
        assert.ok(err.code === 'BAD_REQUEST' || err.message.includes('teamId'));
      }
    });
  });
});