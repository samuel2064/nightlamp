import { Database } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import { broadcastEvent, SSEEventType } from '../api/sse';

export type PlaybookExecutionStatus = 'pending' | 'running' | 'waiting_decision' | 'completed' | 'failed' | 'cancelled';

export type PlaybookStepType = 
  | 'http_request'
  | 'assertion'
  | 'wait'
  | 'conditional'
  | 'notification'
  | 'custom_code';

export interface PlaybookStep {
  id: string;
  type: PlaybookStepType;
  name: string;
  config: Record<string, unknown>;
  nextStepId?: string;
  onFailureStepId?: string;
}

export interface PlaybookDefinition {
  id: string;
  name: string;
  description: string;
  steps: PlaybookStep[];
  variables: Record<string, unknown>;
}

export interface PlaybookExecution {
  id: string;
  playbookId: string;
  status: PlaybookExecutionStatus;
  currentStepId: string | null;
  context: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface StepExecutionResult {
  success: boolean;
  output: Record<string, unknown>;
  nextStepId?: string;
  requiresDecision?: boolean;
  decisionOptions?: string[];
  error?: string;
}

const PLAYBOOK_STATES: PlaybookExecutionStatus[] = [
  'pending',
  'running',
  'waiting_decision',
  'completed',
  'failed',
  'cancelled',
];

const VALID_TRANSITIONS: Record<PlaybookExecutionStatus, PlaybookExecutionStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['waiting_decision', 'completed', 'failed', 'cancelled'],
  waiting_decision: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: ['cancelled'],
  cancelled: [],
};

export class PlaybookEngine {
  private db: Database;
  private executions: Map<string, PlaybookExecution> = new Map();

  constructor(db: Database) {
    this.db = db;
    this.loadExecutions();
  }

  private loadExecutions(): void {
    const result = this.db.exec(
      `SELECT id, playbook_id, status, current_step_id, context, step_results, 
              created_at, updated_at, completed_at, error 
       FROM playbook_executions`
    );
    if (result.length > 0 && result[0].values.length > 0) {
      for (const row of result[0].values) {
        const execution: PlaybookExecution = {
          id: row[0] as string,
          playbookId: row[1] as string,
          status: row[2] as PlaybookExecutionStatus,
          currentStepId: row[3] as string | null,
          context: JSON.parse(row[4] as string),
          stepResults: JSON.parse(row[5] as string),
          createdAt: row[6] as string,
          updatedAt: row[7] as string,
          completedAt: row[8] as string | null,
          error: row[9] as string | null,
        };
        this.executions.set(execution.id, execution);
      }
    }
  }

  async createExecution(playbook: PlaybookDefinition, initialContext: Record<string, unknown> = {}): Promise<PlaybookExecution> {
    const id = uuidv4();
    const now = new Date().toISOString();

    const firstStep = playbook.steps[0];
    if (!firstStep) {
      throw new Error('Playbook has no steps');
    }

    const execution: PlaybookExecution = {
      id,
      playbookId: playbook.id,
      status: 'pending',
      currentStepId: firstStep.id,
      context: { ...playbook.variables, ...initialContext },
      stepResults: {},
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    };

    this.db.run(
      `INSERT INTO playbook_executions (id, playbook_id, status, current_step_id, context, step_results, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, playbook.id, 'pending', firstStep.id, JSON.stringify(execution.context), '{}', now, now]
    );

    this.executions.set(id, execution);
    return execution;
  }

  async startExecution(executionId: string): Promise<PlaybookExecution> {
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    if (!this.canTransition(execution.status, 'running')) {
      throw new Error(`Cannot start execution in status: ${execution.status}`);
    }

    execution.status = 'running';
    execution.updatedAt = new Date().toISOString();
    this.persistExecution(execution);

    broadcastEvent('playbook_progress', {
      executionId: execution.id,
      playbookId: execution.playbookId,
      status: 'running',
      currentStep: execution.currentStepId,
      message: 'Playbook execution started',
    });

    return this.executeNextStep(execution);
  }

  async executeNextStep(execution: PlaybookExecution): Promise<PlaybookExecution> {
    const playbook = this.getPlaybookDefinition(execution.playbookId);
    if (!playbook) {
      execution.status = 'failed';
      execution.error = 'Playbook definition not found';
      execution.completedAt = new Date().toISOString();
      this.persistExecution(execution);
      return execution;
    }

    if (!execution.currentStepId) {
      execution.status = 'completed';
      execution.completedAt = new Date().toISOString();
      this.persistExecution(execution);
      return execution;
    }

    const step = playbook.steps.find(s => s.id === execution.currentStepId);
    if (!step) {
      execution.status = 'failed';
      execution.error = `Step not found: ${execution.currentStepId}`;
      execution.completedAt = new Date().toISOString();
      this.persistExecution(execution);
      return execution;
    }

    broadcastEvent('playbook_progress', {
      executionId: execution.id,
      playbookId: execution.playbookId,
      status: 'running',
      currentStep: step.id,
      stepName: step.name,
      stepType: step.type,
      message: `Executing step: ${step.name}`,
    });

    let result: StepExecutionResult;
    try {
      result = await this.executeStep(step, execution);
    } catch (err: any) {
      result = { success: false, output: {}, error: err.message };
    }

    execution.stepResults[step.id] = result.output;
    execution.updatedAt = new Date().toISOString();

    if (!result.success) {
      if (step.onFailureStepId) {
        execution.currentStepId = step.onFailureStepId;
        this.persistExecution(execution);
        return this.executeNextStep(execution);
      } else {
        execution.status = 'failed';
        execution.error = result.error || `Step ${step.name} failed`;
        execution.completedAt = new Date().toISOString();
        this.persistExecution(execution);
        broadcastEvent('playbook_progress', {
          executionId: execution.id,
          playbookId: execution.playbookId,
          status: 'failed',
          currentStep: step.id,
          error: execution.error,
          message: `Playbook failed at step: ${step.name}`,
        });
        return execution;
      }
    }

    if (result.requiresDecision) {
      execution.status = 'waiting_decision';
      execution.updatedAt = new Date().toISOString();
      this.persistExecution(execution);
      broadcastEvent('playbook_progress', {
        executionId: execution.id,
        playbookId: execution.playbookId,
        status: 'waiting_decision',
        currentStep: step.id,
        decisionOptions: result.decisionOptions,
        message: `Waiting for decision at step: ${step.name}`,
      });
      return execution;
    }

    if (result.nextStepId) {
      execution.currentStepId = result.nextStepId;
    } else if (step.nextStepId) {
      execution.currentStepId = step.nextStepId;
    } else {
      const currentIndex = playbook.steps.findIndex(s => s.id === step.id);
      if (currentIndex + 1 < playbook.steps.length) {
        execution.currentStepId = playbook.steps[currentIndex + 1].id;
      } else {
        execution.currentStepId = null;
      }
    }

    this.persistExecution(execution);

    if (!execution.currentStepId) {
      execution.status = 'completed';
      execution.completedAt = new Date().toISOString();
      this.persistExecution(execution);
      broadcastEvent('playbook_progress', {
        executionId: execution.id,
        playbookId: execution.playbookId,
        status: 'completed',
        currentStep: null,
        message: 'Playbook execution completed successfully',
      });
      return execution;
    }

    return this.executeNextStep(execution);
  }

  private async executeStep(step: PlaybookStep, execution: PlaybookExecution): Promise<StepExecutionResult> {
    switch (step.type) {
      case 'http_request':
        return this.executeHttpRequest(step, execution.context);
      case 'assertion':
        return this.executeAssertion(step, execution.context);
      case 'wait':
        return this.executeWait(step, execution.context);
      case 'conditional':
        return this.executeConditional(step, execution.context);
      case 'notification':
        return this.executeNotification(step, execution.context);
      case 'custom_code':
        return this.executeCustomCode(step, execution.context);
      default:
        return { success: false, output: {}, error: `Unknown step type: ${step.type}` };
    }
  }

  private async executeHttpRequest(step: PlaybookStep, context: Record<string, unknown>): Promise<StepExecutionResult> {
    const config = step.config as {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
      saveResponseAs?: string;
    };

    const url = this.interpolate(config.url, context);
    const method = config.method || 'GET';
    const headers = config.headers ? this.interpolateObject(config.headers, context) : {};
    const body = config.body ? this.interpolateObject(config.body, context) : undefined;

    try {
      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });

      const responseData = await response.json().catch(() => ({}));
      
      const output: Record<string, unknown> = {
        status: response.status,
        statusText: response.statusText,
        data: responseData,
      };

      if (config.saveResponseAs) {
        output[config.saveResponseAs] = responseData;
      }

      return { success: response.ok, output };
    } catch (err: any) {
      return { success: false, output: {}, error: `HTTP request failed: ${err.message}` };
    }
  }

  private async executeAssertion(step: PlaybookStep, context: Record<string, unknown>): Promise<StepExecutionResult> {
    const config = step.config as {
      condition: string;
      message?: string;
    };

    try {
      const result = this.evaluateCondition(config.condition, context);
      return {
        success: result,
        output: { assertionResult: result },
        error: result ? undefined : (config.message || `Assertion failed: ${config.condition}`),
      };
    } catch (err: any) {
      return { success: false, output: {}, error: `Assertion error: ${err.message}` };
    }
  }

  private async executeWait(step: PlaybookStep, context: Record<string, unknown>): Promise<StepExecutionResult> {
    const config = step.config as {
      durationMs?: number;
      until?: string;
      pollIntervalMs?: number;
      maxWaitMs?: number;
    };

    if (config.durationMs) {
      await new Promise(resolve => setTimeout(resolve, config.durationMs));
      return { success: true, output: { waitedMs: config.durationMs } };
    }

    if (config.until) {
      const interval = config.pollIntervalMs || 1000;
      const maxWait = config.maxWaitMs || 60000;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWait) {
        const result = this.evaluateCondition(config.until, context);
        if (result) {
          return { success: true, output: { waitedMs: Date.now() - startTime } };
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
      return { success: false, output: {}, error: `Wait condition not met within ${maxWait}ms` };
    }

    return { success: false, output: {}, error: 'Wait step requires either durationMs or until condition' };
  }

  private async executeConditional(step: PlaybookStep, context: Record<string, unknown>): Promise<StepExecutionResult> {
    const config = step.config as {
      condition: string;
      trueStepId?: string;
      falseStepId?: string;
    };

    const result = this.evaluateCondition(config.condition, context);
    
    return {
      success: true,
      output: { conditionResult: result },
      nextStepId: result ? config.trueStepId : config.falseStepId,
    };
  }

  private async executeNotification(step: PlaybookStep, context: Record<string, unknown>): Promise<StepExecutionResult> {
    const config = step.config as {
      channel: string;
      message: string;
      severity?: 'info' | 'warning' | 'critical';
    };

    broadcastEvent('playbook_progress', {
      executionId: 'notification',
      playbookId: 'notification',
      status: 'notification',
      currentStep: step.id,
      message: this.interpolate(config.message, context),
      severity: config.severity || 'info',
    });

    return { success: true, output: { notified: true } };
  }

  private async executeCustomCode(step: PlaybookStep, context: Record<string, unknown>): Promise<StepExecutionResult> {
    const config = step.config as {
      code: string;
      language?: 'javascript' | 'typescript';
    };

    try {
      const fn = new Function('context', 'utils', `
        return (async () => {
          ${config.code}
        })();
      `);
      
      const result = await fn(context, {
        fetch: globalThis.fetch,
        setTimeout: globalThis.setTimeout,
        Date: globalThis.Date,
        JSON: globalThis.JSON,
        Math: globalThis.Math,
        console: globalThis.console,
      });

      if (result && typeof result === 'object') {
        const { requiresDecision, nextStepId, decisionOptions, ...rest } = result as Record<string, unknown>;
        return {
          success: true,
          output: { result: rest, requiresDecision, nextStepId, decisionOptions },
          requiresDecision: requiresDecision as boolean | undefined,
          nextStepId: nextStepId as string | undefined,
          decisionOptions: decisionOptions as string[] | undefined,
        };
      }

      return { success: true, output: { result } };
    } catch (err: any) {
      return { success: false, output: {}, error: `Custom code execution failed: ${err.message}` };
    }
  }

  private evaluateCondition(condition: string, context: Record<string, unknown>): boolean {
    try {
      const interpolated = this.interpolate(condition, context);
      const fn = new Function('context', `with (context) { return ${interpolated}; }`);
      return !!fn(context);
    } catch {
      return false;
    }
  }

  private interpolate(template: string, context: Record<string, unknown>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
      const value = context[key];
      return value !== undefined ? String(value) : match;
    });
  }

  private interpolateObject(obj: Record<string, unknown>, context: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.interpolate(value, context);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private canTransition(from: PlaybookExecutionStatus, to: PlaybookExecutionStatus): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) || false;
  }

  private persistExecution(execution: PlaybookExecution): void {
    this.db.run(
      `UPDATE playbook_executions SET status = ?, current_step_id = ?, context = ?, step_results = ?, 
              updated_at = ?, completed_at = ?, error = ? WHERE id = ?`,
      [
        execution.status,
        execution.currentStepId,
        JSON.stringify(execution.context),
        JSON.stringify(execution.stepResults),
        execution.updatedAt,
        execution.completedAt,
        execution.error,
        execution.id,
      ]
    );
    this.executions.set(execution.id, execution);
  }

  getPlaybookDefinition(playbookId: string): PlaybookDefinition | null {
    const result = this.db.exec(
      `SELECT id, name, description, variables FROM custom_playbooks WHERE id = ?`,
      [playbookId]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    
    const row = result[0].values[0];
    const stepsResult = this.db.exec(
      `SELECT id, type, subtype, config, position_x, position_y FROM playbook_nodes WHERE playbook_id = ?`,
      [playbookId]
    );
    const edgesResult = this.db.exec(
      `SELECT source_node_id, target_node_id, edge_type FROM playbook_edges WHERE playbook_id = ?`,
      [playbookId]
    );

    const stepMap = new Map<string, PlaybookStep>();
    if (stepsResult.length > 0) {
      for (const row of stepsResult[0].values) {
        const nodeId = row[0] as string;
        const nodeType = row[1] as string; // This is the 'type' column: trigger, condition, action, notification
        const subtype = row[2] as string;   // This is the 'subtype' column: sentry_alert, http_request, custom_code, etc.
        const config = JSON.parse(row[3] as string);
        
        let stepType: PlaybookStepType;
        switch (nodeType) {
          case 'trigger': stepType = 'http_request'; break;
          case 'condition': stepType = 'conditional'; break;
          case 'action': 
            // Check subtype for action nodes
            if (subtype === 'custom_code') stepType = 'custom_code';
            else stepType = 'http_request';
            break;
          case 'notification': stepType = 'notification'; break;
          default: stepType = 'custom_code';
        }
        
        stepMap.set(nodeId, {
          id: nodeId,
          type: stepType,
          name: config.name as string || subtype,
          config,
        });
      }
    }

    const nextStepMap = new Map<string, string>();
    const failureStepMap = new Map<string, string>();
    if (edgesResult.length > 0) {
      for (const row of edgesResult[0].values) {
        const sourceId = row[0] as string;
        const targetId = row[1] as string;
        const edgeType = row[2] as string; // 'next' or 'failure'
        
        if (edgeType === 'failure') {
          failureStepMap.set(sourceId, targetId);
        } else {
          nextStepMap.set(sourceId, targetId);
        }
      }
    }

    // Apply nextStepId from edges
    for (const [sourceId, targetId] of nextStepMap) {
      const sourceStep = stepMap.get(sourceId);
      if (sourceStep) {
        sourceStep.nextStepId = targetId;
      }
    }

    // Apply onFailureStepId from edges
    for (const [sourceId, targetId] of failureStepMap) {
      const sourceStep = stepMap.get(sourceId);
      if (sourceStep) {
        sourceStep.onFailureStepId = targetId;
      }
    }

    return {
      id: row[0] as string,
      name: row[1] as string,
      description: row[2] as string,
      steps: Array.from(stepMap.values()),
      variables: JSON.parse(row[3] as string),
    };
  }

  getExecution(executionId: string): PlaybookExecution | undefined {
    return this.executions.get(executionId);
  }

  listExecutions(playbookId?: string): PlaybookExecution[] {
    let executions = Array.from(this.executions.values());
    if (playbookId) {
      executions = executions.filter(e => e.playbookId === playbookId);
    }
    return executions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async provideDecision(executionId: string, decision: string): Promise<PlaybookExecution> {
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    if (execution.status !== 'waiting_decision') {
      throw new Error(`Execution not waiting for decision: ${execution.status}`);
    }

    execution.context.decision = decision;
    
    // Advance to next step before continuing execution
    const playbook = this.getPlaybookDefinition(execution.playbookId);
    if (playbook) {
      const currentStep = playbook.steps.find(s => s.id === execution.currentStepId);
      if (currentStep && currentStep.nextStepId) {
        execution.currentStepId = currentStep.nextStepId;
      }
    }
    
    execution.status = 'running';
    execution.updatedAt = new Date().toISOString();
    this.persistExecution(execution);

    return this.executeNextStep(execution);
  }

  async cancelExecution(executionId: string): Promise<PlaybookExecution> {
    const execution = this.executions.get(executionId);
    if (!execution) {
      throw new Error(`Execution not found: ${executionId}`);
    }

    if (!this.canTransition(execution.status, 'cancelled')) {
      throw new Error(`Cannot cancel execution in status: ${execution.status}`);
    }

    execution.status = 'cancelled';
    execution.completedAt = new Date().toISOString();
    execution.updatedAt = new Date().toISOString();
    this.persistExecution(execution);

    broadcastEvent('playbook_progress', {
      executionId: execution.id,
      playbookId: execution.playbookId,
      status: 'cancelled',
      message: 'Playbook execution cancelled',
    });

    return execution;
  }
}

export function createPlaybookEngine(db: Database): PlaybookEngine {
  return new PlaybookEngine(db);
}