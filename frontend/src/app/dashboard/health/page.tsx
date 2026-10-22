'use client'

import { useEffect, useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  deriveHealthStatus,
  healthLevelVariant,
  normalizeErrorRatePct,
} from '@/lib/health-status'
import { formatUtcTimestamp, relativeTimestamp } from '@/lib/format'

const REFRESH_INTERVAL_MS = 30_000

export default function HealthPage() {
  const { data: health, isLoading, isError, refetch } = trpc.health.status.useQuery(
    undefined,
    { refetchInterval: REFRESH_INTERVAL_MS },
  )
  const [, forceTick] = useState(0)

  // Turn the relative freshness labels every few seconds.
  useEffect(() => {
    const timer = setInterval(() => forceTick((value) => value + 1), 5_000)
    return () => clearInterval(timer)
  }, [])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex gap-4 py-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-48" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isError) {
    return <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Health</h1>
      <div className="flex items-center gap-2">
        <p className="text-sm text-destructive">Failed to load health data.</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="size-3 mr-1" /> Retry
        </Button>
      </div>
    </div>
  }

  // Status is derived worst-of from the live counters; the stored backend
  // field must never override a non-zero critical counter (see
  // lib/health-status.ts for the rule).
  const derived = deriveHealthStatus(health)

  const items = [
    { key: 'Timestamp', value: formatUtcTimestamp(health?.timestamp), title: formatUtcTimestamp(health?.timestamp) },
    { key: 'Total Checks', value: health?.stats.checks },
    { key: 'Failure Events', value: health?.stats.failureEvents },
    { key: 'Incidents (24h)', value: health?.stats.incidentsLast24h },
    { key: 'Critical (24h)', value: health?.stats.criticalLast24h },
    { key: 'Playbook Entries', value: health?.stats.playbookEntries },
    {
      key: 'Error Rate (24h)',
      value:
        normalizeErrorRatePct(health?.slo?.errorRate24h) !== null
          ? `${normalizeErrorRatePct(health?.slo?.errorRate24h)?.toFixed(2)}%`
          : '-',
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Health</h1>
        <p className="text-sm text-muted-foreground mt-1">
          System health overview
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>System Status</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Status</TableCell>
                <TableCell className="text-right">
                  <Badge variant={healthLevelVariant(derived.status)} title={derived.inconsistent ? 'Backend reports healthy but counters disagree — check data incomplete' : undefined}>
                    {derived.status}
                  </Badge>
                  {derived.inconsistent && (
                    <p className="mt-1 flex items-center justify-end gap-1 text-xs text-warning">
                      <AlertTriangle className="size-3" aria-hidden />
                      Check data incomplete — reported status disagrees with counters.
                    </p>
                  )}
                </TableCell>
              </TableRow>
              {items.map((item) => (
                <TableRow key={item.key}>
                  <TableCell className="font-medium">{item.key}</TableCell>
                  <TableCell className="text-right tabular-nums" title={item.title}>
                    {item.value ?? '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="mt-3 text-right text-xs text-muted-foreground">
            Updated {relativeTimestamp(health?.timestamp)} · refreshes every 30s
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
