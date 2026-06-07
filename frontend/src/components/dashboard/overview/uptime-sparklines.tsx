'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { trpc } from '@/lib/trpc'

export function UptimeSparklines() {
  const { data } = trpc.monitor.health.useQuery(undefined, { retry: false })

  const apps = data?.monitors.map((m) => ({
    name: m.friendlyName,
    uptime: m.uptimeRatio,
    status: m.status === 'up' ? ('operational' as const) : m.status === 'degraded' ? ('degraded' as const) : ('down' as const),
  })) ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Uptime (30d)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {apps.length === 0 ? (
          <p className="text-sm text-muted-foreground">No monitor data available.</p>
        ) : (
          apps.map((app) => (
            <div key={app.name} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${
                    app.status === 'operational' ? 'bg-success' : app.status === 'degraded' ? 'bg-warning' : 'bg-destructive'
                  }`}
                />
                <span className="text-sm">{app.name}</span>
              </div>
              <span className="text-sm font-mono tabular-nums">{app.uptime.toFixed(2)}%</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
