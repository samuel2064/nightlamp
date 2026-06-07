'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { trpc } from '@/lib/trpc'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

function formatLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export default function HealthPage() {
  const { data, isLoading } = trpc.monitor.health.useQuery()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Health</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Per-service health check results
          {data && (
            <span className="ml-2">
              —
              <span className={
                data.overallStatus === 'up' ? 'text-success' :
                data.overallStatus === 'degraded' ? 'text-warning' : 'text-destructive'
              }>
                {' '}{data.overallStatus}
              </span>
            </span>
          )}
        </p>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading health data...</p>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          {data?.monitors.map((svc) => (
            <Card key={svc.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium">{svc.friendlyName}</CardTitle>
                  <span
                    className={`size-2.5 rounded-full ${
                      svc.status === 'up' ? 'bg-success' :
                      svc.status === 'degraded' ? 'bg-warning' : 'bg-destructive'
                    }`}
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Uptime (30d)</span>
                  <span className="font-mono">{svc.uptimeRatio.toFixed(2)}%</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Latency</span>
                  <span className="font-mono">{formatLatency(svc.responseTime)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Last check</span>
                  <span className="font-mono">{timeAgo(svc.lastChecked)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
