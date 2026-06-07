export interface SlackConfig {
  webhookUrl: string
  channel?: string
  username?: string
}

export interface SlackMessage {
  text?: string
  attachments?: SlackAttachment[]
  blocks?: unknown[]
}

export interface SlackAttachment {
  color?: 'good' | 'warning' | 'danger' | string
  title?: string
  text?: string
  fields?: Array<{ title: string; value: string; short?: boolean }>
  footer?: string
  ts?: number
}

export async function sendSlackAlert(config: SlackConfig, message: SlackMessage): Promise<boolean> {
  const payload: Record<string, unknown> = { ...message }
  if (config.channel) payload.channel = config.channel
  if (config.username) payload.username = config.username

  const res = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  return res.ok
}

export function buildBreakingChangeAlert(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  severity: string,
  reasons: string[],
  recommendation: string,
): SlackMessage {
  const color = severity === 'critical' ? 'danger' : severity === 'high' ? 'warning' : 'good'

  return {
    attachments: [
      {
        color,
        title: `Breaking dependency change: ${packageName}`,
        text: `${packageName} ${fromVersion} → ${toVersion}`,
        fields: [
          { title: 'Severity', value: severity.toUpperCase(), short: true },
          { title: 'Package', value: packageName, short: true },
          { title: 'Change', value: `${fromVersion} → ${toVersion}`, short: true },
          { title: 'Reasons', value: reasons.join('\n'), short: false },
          { title: 'Recommendation', value: recommendation, short: false },
        ],
        footer: 'Nightlamp Dependency Monitor',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}

export function buildHealthSummaryAlert(
  totalDeps: number,
  criticalCount: number,
  highCount: number,
  outdatedCount: number,
): SlackMessage {
  const color = criticalCount > 0 ? 'danger' : highCount > 0 ? 'warning' : 'good'

  return {
    attachments: [
      {
        color,
        title: 'Dependency Health Summary',
        fields: [
          { title: 'Total Tracked', value: String(totalDeps), short: true },
          { title: 'Critical', value: String(criticalCount), short: true },
          { title: 'High', value: String(highCount), short: true },
          { title: 'Outdated', value: String(outdatedCount), short: true },
        ],
        footer: 'Nightlamp Dependency Monitor',
        ts: Math.floor(Date.now() / 1000),
      },
    ],
  }
}