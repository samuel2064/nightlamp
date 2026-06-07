export interface Monitor {
  id: number
  friendlyName: string
  url: string
  status: 'up' | 'degraded' | 'down'
  uptimeRatio: number
  responseTime: number
  sslStatus: 'valid' | 'invalid' | 'expired' | 'not_applicable'
  sslDaysRemaining: number | null
  lastChecked: string
}

export interface MonitorHealthResult {
  monitors: Monitor[]
  overallStatus: 'up' | 'degraded' | 'down'
}

export function getMonitors(): MonitorHealthResult {
  const monitors: Monitor[] = [
    {
      id: 1,
      friendlyName: 'Production API',
      url: 'https://api.nightlamp.dev',
      status: 'up',
      uptimeRatio: 99.94,
      responseTime: 245,
      sslStatus: 'valid',
      sslDaysRemaining: 120,
      lastChecked: new Date(Date.now() - 120_000).toISOString(),
    },
    {
      id: 2,
      friendlyName: 'Web App',
      url: 'https://app.nightlamp.dev',
      status: 'up',
      uptimeRatio: 99.87,
      responseTime: 180,
      sslStatus: 'valid',
      sslDaysRemaining: 210,
      lastChecked: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: 3,
      friendlyName: 'Database',
      url: 'postgresql://db.nightlamp.internal:5432',
      status: 'up',
      uptimeRatio: 100,
      responseTime: 12,
      sslStatus: 'valid',
      sslDaysRemaining: 365,
      lastChecked: new Date(Date.now() - 30_000).toISOString(),
    },
    {
      id: 4,
      friendlyName: 'Worker Queue',
      url: 'https://queue.nightlamp.dev',
      status: 'degraded',
      uptimeRatio: 98.23,
      responseTime: 1200,
      sslStatus: 'valid',
      sslDaysRemaining: 90,
      lastChecked: new Date(Date.now() - 300_000).toISOString(),
    },
    {
      id: 5,
      friendlyName: 'Billing Service',
      url: 'https://billing.nightlamp.dev',
      status: 'up',
      uptimeRatio: 99.95,
      responseTime: 320,
      sslStatus: 'valid',
      sslDaysRemaining: 180,
      lastChecked: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: 6,
      friendlyName: 'CDN',
      url: 'https://cdn.nightlamp.dev',
      status: 'up',
      uptimeRatio: 100,
      responseTime: 45,
      sslStatus: 'valid',
      sslDaysRemaining: 150,
      lastChecked: new Date(Date.now() - 60_000).toISOString(),
    },
  ]

  const downCount = monitors.filter((m) => m.status === 'down').length
  const degradedCount = monitors.filter((m) => m.status === 'degraded').length

  let overallStatus: 'up' | 'degraded' | 'down'
  if (downCount > 0) {
    overallStatus = 'down'
  } else if (degradedCount > 0) {
    overallStatus = 'degraded'
  } else {
    overallStatus = 'up'
  }

  return { monitors, overallStatus }
}
