'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc'

const severityConfig: Record<string, { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' }> = {
  critical: { label: 'Critical', variant: 'destructive' },
  high: { label: 'High', variant: 'default' },
  medium: { label: 'Medium', variant: 'secondary' },
  low: { label: 'Low', variant: 'outline' },
  warning: { label: 'Warning', variant: 'outline' },
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export function RecentAlerts() {
  const { data: entries } = trpc.playbook.list.useQuery(undefined, { retry: false })
  const { data: incidents } = trpc.incident.list.useQuery(undefined, { retry: false })

  const alerts = [
    ...(entries?.slice(0, 3).map((e) => ({
      id: `pb-${e.id}`,
      title: e.title,
      resource: e.affectedResource,
      severity: e.severity,
      time: e.createdAt,
    })) ?? []),
    ...(incidents?.slice(0, 3).map((inc) => ({
      id: inc.id,
      title: inc.title,
      resource: inc.resource,
      severity: inc.severity,
      time: inc.time,
    })) ?? []),
  ]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 5)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Recent Alerts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No recent alerts.</p>
        ) : (
          alerts.map((alert) => {
            const cfg = severityConfig[alert.severity] ?? severityConfig.medium
            return (
              <div key={alert.id} className="flex items-start justify-between gap-4">
                <div className="space-y-1 min-w-0">
                  <p className="text-sm font-medium truncate">{alert.title}</p>
                  <p className="text-xs text-muted-foreground">{alert.resource}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={cfg.variant}>{cfg.label}</Badge>
                  <span className="text-xs text-muted-foreground">{timeAgo(alert.time)}</span>
                </div>
              </div>
            )
          })
        )}
      </CardContent>
    </Card>
  )
}
