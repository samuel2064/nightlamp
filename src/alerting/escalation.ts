/**
 * Escalation policy for Nightlamp production alerting.
 *
 * Maps alert severity to an escalation priority (P1/P2/P3) and a chain of
 * escalating channel targets. Includes an on-call rotation placeholder that
 * can be wired to a roster source (Sentry/Lightstep/PagerDuty schedule).
 */

export type EscalationPriority = 'P1' | 'P2' | 'P3';

export type Severity = 'critical' | 'warning' | 'info';

export interface EscalationStep {
  // Human-facing description of the escalation step (e.g. 'on-call eng').
  target: string;
  // Channel type to route this escalation step to.
  channelType: 'pagerduty' | 'slack' | 'email' | 'in-app-websocket';
  // Minutes to wait before escalating to the next level (0 = immediate, -1 = no escalation).
  afterMinutes: number;
  // Acknowledge timeout before the next level is paged (used by on-call tools).
  ackTimeoutMinutes: number;
}

export interface EscalationPolicy {
  priority: EscalationPriority;
  description: string;
  ackTimeoutMinutes: number;
  escalateTo: EscalationStep[];
}

/**
 * Severity to priority mapping is the single source of truth for how critical
 * a production event is. Kept in sync with `src/alerting/evaluator.ts` severity
 * ordering (critical=3, warning=2, info=1).
 */
export const SEVERITY_TO_PRIORITY: Record<Severity, EscalationPriority> = {
  critical: 'P1',
  warning: 'P2',
  info: 'P3',
};

export const ESCALATION_POLICIES: Record<EscalationPriority, EscalationPolicy> = {
  P1: {
    priority: 'P1',
    description:
      'Production outage / data loss / security incident / sustained SLO breach. Immediate attention required around the clock.',
    ackTimeoutMinutes: 10,
    escalateTo: [
      { target: 'on-call-criticals', channelType: 'pagerduty', afterMinutes: 0, ackTimeoutMinutes: 10 },
      { target: '#incidents', channelType: 'slack', afterMinutes: 0, ackTimeoutMinutes: -1 },
      { target: 'eng@nightlamp', channelType: 'email', afterMinutes: 5, ackTimeoutMinutes: -1 },
    ],
  },
  P2: {
    priority: 'P2',
    description:
      'Degraded but not fully down. Elevated error rate or latency breach affecting a subset of users. Respond within severity gate.',
    ackTimeoutMinutes: 60,
    escalateTo: [
      { target: 'on-call-urgent', channelType: 'slack', afterMinutes: 0, ackTimeoutMinutes: 30 },
      { target: '#incidents', channelType: 'slack', afterMinutes: 10, ackTimeoutMinutes: -1 },
    ],
  },
  P3: {
    priority: 'P3',
    description:
      'Non-urgent, low-impact anomaly or routine degradation. Tracked and triaged during business hours.',
    ackTimeoutMinutes: 0,
    escalateTo: [
      { target: '#alerts', channelType: 'slack', afterMinutes: 0, ackTimeoutMinutes: -1 },
      { target: 'in-app dashboard', channelType: 'in-app-websocket', afterMinutes: 0, ackTimeoutMinutes: -1 },
    ],
  },
};

/** Get the escalation policy for an alert severity string. */
export function getPolicyForSeverity(severity: string): EscalationPolicy | null {
  const priority = severityToPriority(severity);
  return priority ? ESCALATION_POLICIES[priority] : null;
}

/** Resolve a raw severity string to its escalation priority. */
export function severityToPriority(severity: string): EscalationPriority | null {
  const normalized = (severity || '').toLowerCase();
  if (normalized in SEVERITY_TO_PRIORITY) {
    return SEVERITY_TO_PRIORITY[normalized as Severity];
  }
  // Fall back on severity labels provided by upstream connectors.
  if (normalized.includes('critical') || normalized.includes('page') || normalized === 'p1') return 'P1';
  if (normalized.includes('warning') || normalized === 'p2') return 'P2';
  return 'P3';
}

export interface OnCallRotation {
  primary: string;
  secondary: string;
  third: string;
  windowStartUtc: string;
  rotationDays: number;
}

/**
 * On-call rotation placeholder.
 *
 * Production integration: populate from a persisted table or an external
 * roster (e.g. PagerDuty schedule API). Returns a static placeholder roster so
 * downstream escalation logic can be built and tested without credentials.
 */
export const DEFAULT_ON_CALL_ROTATION: OnCallRotation = {
  primary: 'backend-engineer',
  secondary: 'cto',
  third: 'ceo',
  windowStartUtc: '2026-08-02T00:00:00Z',
  rotationDays: 7,
};

const DAY_MS = 86400000;

/** Deterministically pick the current on-call engineer for a given ISO timestamp. */
export function getOnCallAt(nowIso: string, rotation: OnCallRotation = DEFAULT_ON_CALL_ROTATION): string {
  const start = Date.parse(rotation.windowStartUtc);
  const now = Date.parse(nowIso);
  if (Number.isNaN(start) || Number.isNaN(now)) return rotation.primary;
  const elapsedDays = Math.floor((now - start) / DAY_MS);
  const window = Math.max(1, rotation.rotationDays || 1);
  const index = Math.floor(elapsedDays / window) % 3;
  return [rotation.primary, rotation.secondary, rotation.third][index] || rotation.primary;
}

/** Resolve which channelType the first escalation step of a severity targets. */
export function getPrimaryChannelType(severity: string): EscalationStep['channelType'] | null {
  const policy = getPolicyForSeverity(severity);
  return policy && policy.escalateTo.length > 0 ? policy.escalateTo[0].channelType : null;
}