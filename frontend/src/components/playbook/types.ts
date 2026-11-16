export type StepType = 'QUESTION' | 'CHECK' | 'ACTION' | 'INFO' | 'BRANCH' | 'RESOLUTION';

export type StepStatus = 'pending' | 'current' | 'completed' | 'skipped';

export type CheckStatus = 'pending' | 'running' | 'success' | 'error';

export interface RunningCheck {
  check: CheckDefinition
  status: 'queued' | 'running' | 'success' | 'error'
  result?: CheckResult
  startTime?: number
}

export interface Option {
  value: string;
  label: string;
  description?: string;
}

export interface CheckDefinition {
  id: string;
  name: string;
  target: string;
  type: 'HTTP' | 'TCP' | 'CUSTOM';
  timeout: number;
}

export interface CheckResult {
  status: 'pass' | 'fail' | 'warn';
  statusCode?: number;
  duration: number;
  output: string;
  keyFields?: Record<string, string>;
}

export interface Step {
  id: string;
  index: number;
  title: string;
  type: StepType;
  status: StepStatus;
  question?: {
    text: string;
    options: Option[];
    allowMultiple: boolean;
    allowCustom: boolean;
  };
  check?: CheckDefinition;
  action?: {
    instructions: string;
    confirmLabel: string;
    requireConfirmation: boolean;
  };
  info?: {
    content: string;
  };
  branch?: {
    condition: string;
    result: boolean;
    truePath: string;
    falsePath: string;
    skippedSteps: string[];
  };
  resolution?: {
    outcome: 'success' | 'partial' | 'escalation';
    rootCause: string;
    actionsTaken: string[];
    prevention: string[];
  };
}

export interface Playbook {
  id: string;
  title: string;
  version: string;
  estimatedDuration: number;
  successRate: number;
  steps: Step[];
}

export interface PlaybookExecution {
  id: string;
  playbookId: string;
  playbook: Playbook;
  currentStepIndex: number;
  completedIndices: number[];
  skippedIndices: number[];
  answers: Record<string, string[]>;
  status: 'running' | 'completed' | 'paused';
  startedAt: string;
  updatedAt: string;
}

export type SSEEvent =
  | { type: 'step'; step: Step }
  | { type: 'check_start'; checkId: string }
  | { type: 'check_progress'; checkId: string; output: string }
  | { type: 'check_complete'; checkId: string; result: CheckResult }
  | { type: 'check_error'; checkId: string; error: string }
  | { type: 'execution_complete'; resolution: Step['resolution'] }
  | { type: 'error'; message: string }
  | { type: 'active_users'; users: ActiveUser[] }

export interface ActiveUser {
  id: string;
  name: string;
  device: string;
  currentStep: number;
  isCurrentUser: boolean;
}

export type RightPanelTab = 'automation' | 'context' | 'notes' | 'history';

export interface PlaybookClientState {
  executionId: string;
  currentStepIndex: number;
  answers: Record<string, string[]>;
  skippedIndices: number[];
  notes: string;
  offlineQueue: Array<{ stepId: string; answer: string[]; skipped: boolean }>;
}