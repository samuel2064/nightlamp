import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';

export type FailureType = 'broken_webhook' | 'expired_token' | 'schema_drift' | 'rate_limit_shift' | 'error_spike' | 'new_error_pattern' | 'remediation_triggered';

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

    if (context.statusCode >= 500) {
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
  }

  return events;
}