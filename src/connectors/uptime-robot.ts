export interface UptimeRobotConfig {
  apiKey: string
}

export type MonitorStatus = 0 | 1 | 2 | 8 | 9

export const MonitorStatusLabel: Record<MonitorStatus, string> = {
  0: 'paused',
  1: 'not_checked_yet',
  2: 'up',
  8: 'seems_down',
  9: 'down',
}

export interface UptimeRobotMonitor {
  id: number
  friendlyName: string
  url: string
  type: number
  status: MonitorStatus
  statusLabel: string
  uptimeRatio: number
  ssl: {
    status: 'not_applicable' | 'valid' | 'invalid' | 'expired' | 'error'
    daysRemaining?: number
  }
  responseTime: number
  createDateTime: string
}

export interface UptimeRobotDowntimeEvent {
  monitorId: number
  monitorName: string
  duration: number
  startedAt: string
  reason: string
}

export interface UptimeRobotPollResult {
  monitors: UptimeRobotMonitor[]
  downMonitors: UptimeRobotMonitor[]
  sslIssues: UptimeRobotMonitor[]
  slowMonitors: UptimeRobotMonitor[]
  overallStatus: 'up' | 'degraded' | 'down'
}

const UPTIMEROBOT_API_BASE = 'https://api.uptimerobot.com/v2'

export async function pollUptimeRobotMonitors(
  config: UptimeRobotConfig,
  options?: { responseTimes?: number; logs?: number; customUptimeRanges?: number },
): Promise<UptimeRobotPollResult> {
  const params = new URLSearchParams()
  params.set('api_key', config.apiKey)
  params.set('format', 'json')
  params.set('response_times', String(options?.responseTimes ?? 1))
  params.set('logs', String(options?.logs ?? 1))
  params.set('custom_uptime_ranges', String(options?.customUptimeRanges ?? 1))

  const url = `${UPTIMEROBOT_API_BASE}/getMonitors`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: params.toString(),
  })

  if (!res.ok) {
    throw new Error(`UptimeRobot API returned ${res.status}`)
  }

  const data = await res.json() as {
    stat: 'ok' | 'fail'
    monitors?: Array<{
      id: number
      friendly_name: string
      url: string
      type: number
      status: MonitorStatus
      uptime_ratio: number
      ssl: {
        status: 'not_applicable' | 'valid' | 'invalid' | 'expired' | 'error'
        days_remaining?: number
      }
      response_times?: Array<{ value: number }>
      create_datetime: number
    }>
  }

  if (data.stat !== 'ok') {
    throw new Error(`UptimeRobot API error: stat=${data.stat}`)
  }

  const monitors: UptimeRobotMonitor[] = (data.monitors || []).map((m) => ({
    id: m.id,
    friendlyName: m.friendly_name,
    url: m.url,
    type: m.type,
    status: m.status,
    statusLabel: MonitorStatusLabel[m.status] || 'unknown',
    uptimeRatio: m.uptime_ratio,
    ssl: {
      status: m.ssl?.status || 'not_applicable',
      daysRemaining: m.ssl?.days_remaining,
    },
    responseTime: m.response_times?.[0]?.value || 0,
    createDateTime: new Date(m.create_datetime * 1000).toISOString(),
  }))

  const downMonitors = monitors.filter((m) => m.status === 9 || m.status === 8)
  const sslIssues = monitors.filter((m) => m.ssl.status === 'invalid' || m.ssl.status === 'expired' || m.ssl.status === 'error')
  const slowMonitors = monitors.filter((m) => m.status === 2 && m.responseTime > 5000)

  let overallStatus: 'up' | 'degraded' | 'down'
  if (downMonitors.length > 0) {
    overallStatus = 'down'
  } else if (sslIssues.length > 0) {
    overallStatus = 'degraded'
  } else {
    overallStatus = 'up'
  }

  return { monitors, downMonitors, sslIssues, slowMonitors, overallStatus }
}

export async function getUptimeRobotMonitorDetail(
  config: UptimeRobotConfig,
  monitorId: number,
): Promise<UptimeRobotMonitor | null> {
  const params = new URLSearchParams()
  params.set('api_key', config.apiKey)
  params.set('format', 'json')
  params.set('monitors', String(monitorId))
  params.set('response_times', '1')
  params.set('logs', '1')
  params.set('custom_uptime_ranges', '1')

  const url = `${UPTIMEROBOT_API_BASE}/getMonitors`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: params.toString(),
  })

  if (!res.ok) return null

  const data = await res.json() as {
    stat: 'ok' | 'fail'
    monitors?: Array<{
      id: number
      friendly_name: string
      url: string
      type: number
      status: MonitorStatus
      uptime_ratio: number
      ssl: {
        status: 'not_applicable' | 'valid' | 'invalid' | 'expired' | 'error'
        days_remaining?: number
      }
      response_times?: Array<{ value: number }>
      create_datetime: number
    }>
  }

  if (data.stat !== 'ok' || !data.monitors || data.monitors.length === 0) return null

  const m = data.monitors[0]
  return {
    id: m.id,
    friendlyName: m.friendly_name,
    url: m.url,
    type: m.type,
    status: m.status,
    statusLabel: MonitorStatusLabel[m.status] || 'unknown',
    uptimeRatio: m.uptime_ratio,
    ssl: {
      status: m.ssl?.status || 'not_applicable',
      daysRemaining: m.ssl?.days_remaining,
    },
    responseTime: m.response_times?.[0]?.value || 0,
    createDateTime: new Date(m.create_datetime * 1000).toISOString(),
  }
}
