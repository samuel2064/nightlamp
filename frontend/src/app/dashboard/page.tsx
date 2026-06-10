'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'

export default function DashboardOverview() {
  const { data: health, isLoading: healthLoading, isError: healthError, refetch: refetchHealth } = trpc.health.status.useQuery()
  const { data: incidents, isLoading: incLoading } = trpc.incidents.list.useQuery({ limit: 5 })
  const { data: activity, isLoading: actLoading } = trpc.activity.list.useQuery({ limit: 10 })
  const { data: monitors, isLoading: monLoading } = trpc.monitors.list.useQuery()
  const { data: playbook, isLoading: pbLoading } = trpc.playbook.list.useQuery()

  const loading = healthLoading || monLoading || incLoading || actLoading || pbLoading

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-52" />
          </div>
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-9 w-12" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-36" />
              </CardHeader>
              <CardContent className="space-y-3">
                {Array.from({ length: 4 }).map((_, j) => (
                  <div key={j} className="flex items-center gap-3">
                    <Skeleton className="size-6 rounded-full shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-3/5" />
                      <Skeleton className="h-3 w-2/5" />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (healthError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">System status overview</p>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load dashboard data.</p>
          <Button variant="outline" size="sm" onClick={() => refetchHealth()}>
            <RefreshCw className="size-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  const stats = [
    { label: 'Total Checks', value: health?.stats.checks ?? 0 },
    { label: 'Failure Events', value: health?.stats.failureEvents ?? 0, variant: health && health.stats.failureEvents > 0 ? 'destructive' as const : 'default' as const },
    { label: 'Playbook Entries', value: health?.stats.playbookEntries ?? 0 },
    { label: 'Monitors', value: monitors?.count ?? 0 },
    { label: 'Incidents', value: incidents?.count ?? 0 },
    { label: 'Playbooks', value: playbook?.count ?? 0 },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            System status overview
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className={`size-2 rounded-full ${health?.status === 'healthy' ? 'bg-green-500' : 'bg-yellow-500'}`} />
          {health?.status ?? 'unknown'}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-3xl font-bold ${'variant' in s && s.variant === 'destructive' ? 'text-destructive' : ''}`}>{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Recent Incidents</CardTitle>
          </CardHeader>
          <CardContent>
            {!incidents || incidents.events.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="No recent incidents"
                description="All systems are operating normally."
              />
            ) : (
              <div className="space-y-3">
                {incidents.events.map((e) => (
                  <div key={e.id} className="flex items-start gap-3 text-sm">
                    <Badge variant={e.severity === 'critical' ? 'destructive' : 'secondary'} className="shrink-0 mt-0.5">
                      {e.severity}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{e.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(e.detectedAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {!activity || activity.activity.length === 0 ? (
              <EmptyState
                icon={AlertTriangle}
                title="No recent activity"
                description="System activity will appear here."
              />
            ) : (
              <div className="space-y-2">
                {activity.activity.map((a) => (
                  <div key={a.id} className="flex items-start gap-2 text-sm">
                    <span className="text-xs text-muted-foreground shrink-0 w-16">
                      {new Date(a.timestamp).toLocaleDateString()}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{a.type}</Badge>
                    <span className="truncate">{a.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
