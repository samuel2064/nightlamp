export type ForwardStatus = 'not_configured' | 'sent' | 'failed';

export interface ForwardResult {
  forwarded: boolean;
  status: ForwardStatus;
  error?: string;
}

export interface ForwardableEvent {
  event: string;
  event_id: string;
  schema_version: string;
  timestamp: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

export function postHogConfig(): { apiKey: string; host: string } | null {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey || !apiKey.trim()) return null;
  const host = (process.env.POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, '');
  return { apiKey, host };
}

export async function forwardAnalyticsEvent(event: ForwardableEvent): Promise<ForwardResult> {
  const config = postHogConfig();
  if (!config) {
    return {
      forwarded: false,
      status: 'not_configured',
      error: 'POSTHOG_API_KEY is not configured on this deployment',
    };
  }

  try {
    const response = await fetch(`${config.host}/capture/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: config.apiKey,
        event: event.event,
        distinct_id: event.distinct_id,
        timestamp: event.timestamp,
        properties: {
          ...event.properties,
          event_id: event.event_id,
          schema_version: event.schema_version,
          $lib: 'nightlamp-backend',
        },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        forwarded: false,
        status: 'failed',
        error: `analytics provider answered with status ${response.status}`,
      };
    }

    return { forwarded: true, status: 'sent' };
  } catch (err: any) {
    return {
      forwarded: false,
      status: 'failed',
      error: err?.message ? String(err.message).slice(0, 200) : 'analytics provider unreachable',
    };
  }
}
