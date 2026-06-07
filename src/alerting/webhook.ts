export interface WebhookConfig {
  url: string
  headers?: Record<string, string>
  method?: 'POST' | 'PUT'
}

export interface WebhookPayload {
  event: string
  timestamp: string
  data: Record<string, unknown>
}

export type WebhookResult = { ok: true; statusCode: number } | { ok: false; error: string }

export async function sendWebhook(config: WebhookConfig, payload: WebhookPayload): Promise<WebhookResult> {
  try {
    const res = await fetch(config.url, {
      method: config.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...config.headers,
      },
      body: JSON.stringify(payload),
    })
    return { ok: res.ok as true, statusCode: res.status }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function buildDependencyChangePayload(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  severity: string,
  reasons: string[],
): WebhookPayload {
  return {
    event: 'dependency.change',
    timestamp: new Date().toISOString(),
    data: {
      package: packageName,
      fromVersion,
      toVersion,
      severity,
      reasons,
      changeType: severity === 'critical' || severity === 'high' ? 'breaking' : 'non-breaking',
    },
  }
}

export function buildHealthCheckPayload(
  totalDeps: number,
  critical: number,
  high: number,
  medium: number,
  low: number,
): WebhookPayload {
  return {
    event: 'dependency.health',
    timestamp: new Date().toISOString(),
    data: {
      totalDependencies: totalDeps,
      bySeverity: { critical, high, medium, low },
      healthy: totalDeps - critical - high - medium - low,
    },
  }
}