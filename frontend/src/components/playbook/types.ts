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

export interface QuestionDefinition {
  text: string;
  options: Option[];
  allowMultiple: boolean;
  allowCustom: boolean;
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

export interface ActionDefinition {
  instructions: string;
  confirmLabel: string;
  requireConfirmation: boolean;
}

export interface InfoDefinition {
  content: string;
}

export interface BranchDefinition {
  condition: string;
  result: boolean;
  truePath: string;
  falsePath: string;
  skippedSteps: string[];
}

export interface ResolutionDefinition {
  outcome: 'success' | 'partial' | 'escalation';
  rootCause: string;
  actionsTaken: string[];
  prevention: string[];
}

interface StepBase {
  id: string;
  index: number;
  title: string;
  status: StepStatus;
}

export interface QuestionStep extends StepBase {
  type: 'QUESTION';
  question: QuestionDefinition;
}

export interface CheckStep extends StepBase {
  type: 'CHECK';
  check: CheckDefinition;
}

export interface ActionStep extends StepBase {
  type: 'ACTION';
  action: ActionDefinition;
}

export interface InfoStep extends StepBase {
  type: 'INFO';
  info: InfoDefinition;
}

export interface BranchStep extends StepBase {
  type: 'BRANCH';
  branch: BranchDefinition;
}

export interface ResolutionStep extends StepBase {
  type: 'RESOLUTION';
  resolution: ResolutionDefinition;
}

export type Step =
  | QuestionStep
  | CheckStep
  | ActionStep
  | InfoStep
  | BranchStep
  | ResolutionStep;

export interface Playbook {
  id: string;
  title: string;
  version?: string;
  estimatedDuration?: number;
  successRate?: number;
  steps: Step[];
}

export interface PlaybookEntry {
  id: string;
  failureType: string;
  title: string;
  firstSeenAt: string;
  lastOccurrenceAt: string;
  occurrenceCount: number;
}

export interface DiagnosticEntry extends PlaybookEntry {
  index?: number;
  type?: StepType;
  status?: StepStatus;
  question?: Partial<QuestionDefinition>;
  check?: CheckDefinition;
  action?: Partial<ActionDefinition>;
  info?: InfoDefinition;
  branch?: BranchDefinition;
  resolution?: ResolutionDefinition;
  steps?: Step[];
  playbook?: Playbook;
  playbookId?: string;
  executablePlaybookId?: string;
}

export interface ExecutableDefinition {
  playbookId: string;
  playbook: Playbook;
}

export type PlaybookExecutionStatus =
  | 'pending'
  | 'running'
  | 'waiting_decision'
  | 'completed'
  | 'failed'
  | 'cancelled';

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

export interface ServerDiagnostic {
  id: string;
  stepId: string;
  title: string;
  status: CheckStatus;
  output: string;
}

export type SSEEvent =
  | { type: 'step'; step: Step }
  | { type: 'check_start'; checkId: string }
  | { type: 'check_progress'; checkId: string; output: string }
  | { type: 'check_complete'; checkId: string; result: CheckResult }
  | { type: 'check_error'; checkId: string; error: string }
  | { type: 'execution_complete'; resolution: ResolutionDefinition }
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

function inferDiagnosticType(entry: DiagnosticEntry): StepType | null {
  if (entry.type) return entry.type;
  if (entry.action) return 'ACTION';
  if (entry.question) return 'QUESTION';
  if (entry.info) return 'INFO';
  if (entry.check) return 'CHECK';
  if (entry.branch) return 'BRANCH';
  if (entry.resolution) return 'RESOLUTION';
  return null;
}

export function mapDiagnosticStep(entry: DiagnosticEntry): Step | null {
  const type = inferDiagnosticType(entry);
  const base = {
    id: entry.id,
    index: entry.index ?? 0,
    title: entry.title,
    status: entry.status ?? 'current',
  };

  switch (type) {
    case 'QUESTION': {
      if (!entry.question?.text) return null;
      return {
        ...base,
        type: 'QUESTION',
        question: {
          text: entry.question.text,
          options: entry.question.options ?? [],
          allowMultiple: entry.question.allowMultiple ?? false,
          allowCustom: entry.question.allowCustom ?? false,
        },
      };
    }
    case 'CHECK':
      return entry.check ? { ...base, type: 'CHECK', check: entry.check } : null;
    case 'ACTION': {
      if (!entry.action?.instructions?.trim()) return null;
      return {
        ...base,
        type: 'ACTION',
        action: {
          instructions: entry.action.instructions,
          confirmLabel: entry.action.confirmLabel ?? 'Complete',
          requireConfirmation: entry.action.requireConfirmation ?? false,
        },
      };
    }
    case 'INFO':
      return entry.info?.content ? { ...base, type: 'INFO', info: entry.info } : null;
    case 'BRANCH':
      return entry.branch ? { ...base, type: 'BRANCH', branch: entry.branch } : null;
    case 'RESOLUTION':
      return entry.resolution ? { ...base, type: 'RESOLUTION', resolution: entry.resolution } : null;
    default:
      return null;
  }
}

export function mapDiagnosticToExecutable(entry: DiagnosticEntry): ExecutableDefinition | null {
  const steps = entry.steps?.length
    ? entry.steps
    : entry.playbook?.steps?.length
      ? entry.playbook.steps
      : (() => {
          const step = mapDiagnosticStep(entry);
          return step ? [step] : [];
        })();

  if (steps.length === 0) return null;

  const playbookId = entry.playbookId ?? entry.executablePlaybookId ?? entry.id;
  const playbook: Playbook = entry.playbook
    ? { ...entry.playbook, id: entry.playbook.id || entry.id, title: entry.playbook.title || entry.title, steps }
    : {
        id: entry.id,
        title: entry.title,
        steps,
      };

  return { playbookId, playbook };
}
