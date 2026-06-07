import { getIncidents } from './incidents.js'

export interface ActivityEvent {
  id: string
  type: 'alert' | 'status' | 'deploy' | 'playbook'
  message: string
  resource: string
  severity: 'critical' | 'warning' | 'info' | 'success'
  time: string
}

export function getActivity(): ActivityEvent[] {
  const incidents = getIncidents()

  const events: ActivityEvent[] = [
    {
      id: 'act-1',
      type: 'status',
      message: 'Health check passed for all services',
      resource: 'Health Checker',
      severity: 'success',
      time: new Date(Date.now() - 60_000).toISOString(),
    },
    {
      id: 'act-2',
      type: 'deploy',
      message: 'Dependency scan completed - 5 new updates found',
      resource: 'Dependency Tracker',
      severity: 'info',
      time: new Date(Date.now() - 300_000).toISOString(),
    },
    ...incidents.slice(0, 3).map((inc, i) => ({
      id: `act-inc-${i}`,
      type: 'alert' as const,
      message: inc.title,
      resource: inc.resource,
      severity: (inc.severity === 'critical' ? 'critical' : inc.severity === 'high' ? 'warning' : 'info') as 'critical' | 'warning' | 'info',
      time: inc.time,
    })),
  ]

  events.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())

  return events
}
