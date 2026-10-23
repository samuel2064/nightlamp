'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Cpu,
  RefreshCw,
  Radio,
  Plus,
  ShieldCheck,
} from 'lucide-react'
import {
  deriveHealthStatus,
  healthLevelVariant,
  normalizeErrorRatePct,
} from '@/lib/health-status'
import { formatUtcTimestamp, relativeTimestamp } from '@/lib/format'

const REFRESH_INTERVAL_MS = 30_000

type MonitorStatus = 'healthy' | 'degraded' | 'critical' | 'unknown'

// Truthfulness: a monitor card is only green when its own latest check says so.
// Missing/ambiguous status renders gray `unknown`, never green.
function deriveMonitorStatus(lastStatus: string | null | undefined): MonitorStatus {
  switch ((lastStatus ?? '').toLowerCase()) {
    case 'fail':
    case 'critical':
      return 'critical'
    case 'degraded':
    case 'warn':
      return 'degraded'
    case 'ok':
    case 'pass':
    case 'healthy':
      return 'healthy'
    default:
      return 'unknown'
  }
}

const MONITOR_VARIANT: Record<MonitorStatus, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'destructive',
  unknown: 'secondary',
}

const ACTIVITY_META: Record<string, { icon: typeof Activity; className: string }> = {
  incident: { icon: AlertTriangle, className: 'text-destructive' },
  event: { icon: Radio, className: 'text-warning' },
  check: { icon: CheckCircle2, className: 'text-muted-foreground' },
  playbook: { icon: Bot, className: 'text-info' },
}

function InlineError({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span className="flex-1">{message}</span>
      <Button variant="outline" size="sm" onClick={retry} className="shrink-0">
        <RefreshCw className="size-3 mr-1" aria-hidden /> Retry
      </Button>
    </div>
  )
}

export default function DashboardOverview() {
  const healthQuery = trpc.health.status.useQuery(undefined, {
    refetchInterval: REFRESH_INTERVAL_MS,
  })
  const monitorsQuery = trpc.monitors.list.useQuery(undefined, {
    refetchInterval: REFRESH_INTERVAL_MS,
  })
  const incidentsQuery = trpc.incidents.list.useQuery({ limit: 5 }, {
    refetchInterval: REFRESH_INTERVAL_MS,
  })
  const activityQuery = trpc.activity.list.useQuery({ limit: 4 }, {
    refetchInterval: REFRESH_INTERVAL_MS,
  })

  const [, forceTick] = useState(0)

  // Tick relative timestamps ("just now") every 5s while the tab is visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') forceTick((value) => value + 1)
    }, 5_000)
    return () => clearInterval(timer)
  }, [])

  const loading = healthQuery.isLoading || monitorsQuery.isLoading || incidentsQuery.isLoading || activityQuery.isLoading

  if (loading) {
    return (
      <div className="space-y-6" aria-busy="true" aria-live="polite">
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-6">
            <div className="space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-9 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-9 w-44 rounded-md" />
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="space-y-2 py-4">
                <Skeleton className="h-6 w-6" />
                <Skeleton className="h-9 w-16" />
                <Skeleton className="h-4 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <Skeleton className="h-5 w-28" />
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Card key={i}>
                  <CardContent className="space-y-2 py-4">
                    <Skeleton className="h-4 w-28" />
                    <Skeleton className="h-4 w-20" />
                    <Skeleton className="h-3 w-24" />
                  </CardContent>
                </Card>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <Skeleton className="h-5 w-36" />
            </CardHeader>
            <CardContent className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3">
                  <Skeleton className="size-6 rounded-full shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-4/5" />
                    <Skeleton className="h-3 w-2/5" />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  const health = healthQuery.data
  const derived = deriveHealthStatus(health)
  const errorRatePct = normalizeErrorRatePct(health?.slo?.errorRate24h)
  // Same-snapshot honesty: overall health % is 100 minus the observed error
  // rate; unknown inputs stay unknown ('-'), never a fabricated number.
  const healthScore =
    errorRatePct !== null
      ? Math.max(0, Math.round((100 - errorRatePct) * 10) / 10)
      : null

  const metricCards = [
    {
      icon: Cpu,
      label: 'Apps monitored',
      value: monitorsQuery.data ? monitorsQuery.data.count : null,
      destructive: false,
    },
    {
      icon: AlertTriangle,
      label: 'Incidents (24h)',
      value: health?.stats.incidentsLast24h ?? null,
      destructive: (health?.stats.incidentsLast24h ?? 0) > 0,
    },
    {
      icon: ShieldCheck,
      label: 'Critical (24h)',
      value: health?.stats.criticalLast24h ?? null,
      destructive: (health?.stats.criticalLast24h ?? 0) > 0,
    },
    {
      icon: Activity,
      label: 'Error rate (24h)',
      value: errorRatePct !== null ? `${errorRatePct.toFixed(2)}%` : null,
      destructive: errorRatePct !== null && errorRatePct > 0,
    },
  ]

  const monitors = monitorsQuery.data?.monitors ?? []
  const incidents = incidentsQuery.data?.events ?? []
  const activity = activityQuery.data?.activity ?? []

  return (
    <div className="space-y-6">
      {/* Hero */}
      <Card>
        <CardContent className="flex flex-col gap-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Overall health of your stack</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <p className="text-4xl font-bold tabular-nums">
                {healthScore !== null ? `${healthScore}%` : '—'}
              </p>
              <Badge
                variant={healthLevelVariant(derived.status)}
                aria-label={`Status: ${derived.status}`}
              >
                {derived.status}
              </Badge>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Last check: {relativeTimestamp(health?.timestamp)} · {formatUtcTimestamp(health?.timestamp)}
            </p>
            {derived.inconsistent && (
              <p className="mt-1 flex items-center gap-1 text-xs text-warning">
                <AlertTriangle className="size-3" aria-hidden />
                Check data incomplete — reported status disagrees with counters.
              </p>
            )}
          </div>
          <Button
            className="shrink-0"
            onClick={() => healthQuery.refetch()}
            disabled={healthQuery.isRefetching}
            aria-live="polite"
          >
            <RefreshCw className={`size-4 mr-2 ${healthQuery.isRefetching ? 'animate-spin' : ''}`} aria-hidden />
            {healthQuery.isRefetching ? 'Running check…' : 'Run health check'}
          </Button>
        </CardContent>
      </Card>

      {/* Metrics row: values unknown until measured — '-' beats a fake zero. */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {metricCards.map((metric) => (
          <Card key={metric.label}>
            <CardContent className="py-4">
              <metric.icon className={`size-5 ${metric.destructive ? 'text-destructive' : 'text-glow-500'}`} aria-hidden />
              <p className={`mt-2 text-3xl font-bold tabular-nums ${metric.destructive ? 'text-destructive' : ''}`}>
                {metric.value ?? '—'}
              </p>
              <p className="text-sm text-muted-foreground">{metric.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Your apps */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg">Your apps</CardTitle>
          </CardHeader>
          <CardContent>
            {monitorsQuery.isError ? (
              <InlineError message="Couldn't load your app checks." retry={() => monitorsQuery.refetch()} />
            ) : monitors.length === 0 ? (
              <EmptyState
                icon={Plus}
                title="No apps monitored yet"
                description="Add your first app to start watching for issues."
                action={
                  <Link href="/dashboard/settings" className={buttonVariants({ variant: 'default', size: 'sm' })}>
                    <Plus className="size-4 mr-1" aria-hidden /> Add app
                  </Link>
                }
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {monitors.slice(0, 6).map((monitor) => {
                  const status = deriveMonitorStatus(monitor.lastStatus)
                  return (
                    <Card key={monitor.id} className="hover:border-glow-500/60 transition-colors">
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium" title={monitor.name}>
                            {monitor.name}
                          </span>
                          <Badge variant={MONITOR_VARIANT[status]} className="shrink-0">
                            {status}
                          </Badge>
                        </div>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Last run: {relativeTimestamp(monitor.lastRun)} ·{' '}
                          <span title={formatUtcTimestamp(monitor.lastRun)}>
                            {formatUtcTimestamp(monitor.lastRun)}
                          </span>
                        </p>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent incidents */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Recent incidents</CardTitle>
          </CardHeader>
          <CardContent>
            {incidentsQuery.isError ? (
              <InlineError message="Couldn't load incidents." retry={() => incidentsQuery.refetch()} />
            ) : incidents.length === 0 ? (
              <EmptyState
                icon={CheckCircle2}
                title="No incidents — everything is healthy"
                description="New incidents will appear here the moment monitoring detects them."
              />
            ) : (
              <ul className="space-y-3">
                {incidents.slice(0, 4).map((incident) => (
                  <li key={incident.id} className="flex items-start gap-3 text-sm">
                    <AlertTriangle className={`mt-0.5 size-4 shrink-0 ${incident.severity === 'critical' ? 'text-destructive' : 'text-warning'}`} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium" title={incident.title}>
                        {incident.title}
                      </p>
                      <p className="text-xs text-muted-foreground" title={formatUtcTimestamp(incident.detectedAt)}>
                        {relativeTimestamp(incident.detectedAt)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Recent activity</CardTitle>
        </CardHeader>
        <CardContent>
          {activityQuery.isError ? (
            <InlineError message="Couldn't load activity." retry={() => activityQuery.refetch()} />
          ) : activity.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No activity yet"
              description="Checks, incidents, and playbook runs will stream in here."
            />
          ) : (
            <ul className="space-y-3">
              {activity.map((entry) => {
                const meta = ACTIVITY_META[entry.type] ?? ACTIVITY_META.check
                const Icon = meta.icon
                return (
                  <li key={entry.id} className="flex items-start gap-3 text-sm">
                    <Icon className={`mt-0.5 size-4 shrink-0 ${meta.className}`} aria-hidden />
                    <p className="min-w-0 flex-1 truncate" title={entry.summary}>
                      {entry.summary}
                    </p>
                    <span
                      className="shrink-0 text-xs text-muted-foreground tabular-nums"
                      title={formatUtcTimestamp(entry.timestamp)}
                    >
                      {relativeTimestamp(entry.timestamp)}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
