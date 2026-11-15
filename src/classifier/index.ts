import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';

export type FailureType = 'broken_webhook' | 'expired_token' | 'schema_drift' | 'rate_limit_shift' | 'error_spike' | 'new_error_pattern' | 'remediation_triggered' | 'slo_breach';

export interface FailureEvent {
  id: string;
  checkId: string;
  failureType: FailureType;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  rawData: any;
  detectedAt: string;
}

export function classifyFailure(
  checkId: string,
  context: { statusCode?: number; errorMessage?: string; headers?: Record<string, string>; body?: any }
): FailureEvent[] {
  const events: FailureEvent[] = [];
  const now = new Date().toISOString();

  if (context.statusCode) {
    if (context.statusCode >= 400 && context.statusCode < 500) {
      let matched = false;

      if (context.statusCode === 401 || context.statusCode === 403) {
        const msg = context.errorMessage || '';
        if (msg.toLowerCase().includes('expired') || msg.toLowerCase().includes('invalid token') || msg.toLowerCase().includes('unauthorized')) {
          events.push({
            id: uuidv4(),
            checkId,
            failureType: 'expired_token',
            severity: 'critical',
            title: 'Expired or invalid authentication token detected',
            description: `Status ${context.statusCode}: ${msg || 'No details'}`,
            rawData: context,
            detectedAt: now,
          });
          matched = true;
        }
      }

      if (context.statusCode === 429) {
        events.push({
          id: uuidv4(),
          checkId,
          failureType: 'rate_limit_shift',
          severity: 'warning',
          title: 'Rate limit hit - possible shift in API rate limits',
          description: `HTTP 429 received. Headers: ${JSON.stringify(context.headers)}`,
          rawData: context,
          detectedAt: now,
        });
        matched = true;
      }

      if (!matched) {
        events.push({
          id: uuidv4(),
          checkId,
          failureType: 'broken_webhook',
          severity: 'warning',
          title: 'Unexpected HTTP client error on API call',
          description: `Status ${context.statusCode}: ${context.errorMessage || 'No details'}`,
          rawData: context,
          detectedAt: now,
        });
      }
    }

    if (context.statusCode >= 500 && context.errorMessage) {
      const msg = context.errorMessage.toLowerCase();
      if (
        msg.includes('degraded') ||
        msg.includes('slow') ||
        msg.includes('latency') ||
        msg.includes('timeout') ||
        msg.includes('slo') ||
        msg.includes('service level')
      ) {
        events.push({
          id: uuidv4(),
          checkId,
          failureType: 'slo_breach',
          severity: 'critical',
          title: 'SLO breach detected',
          description: `Status ${context.statusCode}: ${context.errorMessage || 'Server error on webhook callback'}`,
          rawData: context,
          detectedAt: now,
        });
      } else {
        events.push({
          id: uuidv4(),
          checkId,
          failureType: 'broken_webhook',
          severity: 'critical',
          title: 'Webhook endpoint returning server errors',
          description: `Status ${context.statusCode}: ${context.errorMessage || 'Server error on webhook callback'}`,
          rawData: context,
          detectedAt: now,
        });
      }
    } else if (context.statusCode >= 500) {
      events.push({
        id: uuidv4(),
        checkId,
        failureType: 'broken_webhook',
        severity: 'critical',
        title: 'Webhook endpoint returning server errors',
        description: `Status ${context.statusCode}: ${context.errorMessage || 'Server error on webhook callback'}`,
        rawData: context,
        detectedAt: now,
      });
    }
  }

  if (context.body && typeof context.body === 'object') {
    const bodyKeys = Object.keys(context.body);
    if (bodyKeys.length === 0 || bodyKeys.some((k) => k.startsWith('_'))) {
      events.push({
        id: uuidv4(),
        checkId,
        failureType: 'schema_drift',
        severity: 'warning',
        title: 'Unexpected API response structure - possible schema drift',
        description: `Response keys: [${bodyKeys.join(', ')}]`,
        rawData: context,
        detectedAt: now,
      });
    }

    if (
      bodyKeys.some(
        (k) => k.includes('error') || k.includes('message') || k.includes('detail'),
      )
    ) {
      events.push({
        id: uuidv4(),
        checkId,
        failureType: 'error_spike',
        severity: 'critical',
        title: 'Error spike in API response',
        description: `Response contains error-related keys: [${bodyKeys.join(', ')}]`,
        rawData: context,
        detectedAt: now,
      });
    }

    if (
      bodyKeys.some(
        (k) => k.includes('new') || k.includes('first') || k.includes('unseen'),
      )
    ) {
      events.push({
        id: uuidv4(),
        checkId,
        failureType: 'new_error_pattern',
        severity: 'warning',
        title: 'New error pattern detected',
        description: `Response contains new error pattern indicators: [${bodyKeys.join(', ')}]`,
        rawData: context,
        detectedAt: now,
      });
    }
  }

  return events;
}