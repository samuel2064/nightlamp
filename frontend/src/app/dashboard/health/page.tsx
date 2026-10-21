'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export default function HealthPage() {
  const { data: health, isLoading, isError, refetch } = trpc.health.status.useQuery()

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

  const items = [
    { key: 'Timestamp', value: health?.timestamp ? new Date(health.timestamp).toLocaleString() : '-' },
    { key: 'Total Checks', value: health?.stats.checks },
    { key: 'Failure Events', value: health?.stats.failureEvents },
    { key: 'Incidents (24h)', value: health?.stats.incidentsLast24h },
    { key: 'Critical (24h)', value: health?.stats.criticalLast24h },
    { key: 'Playbook Entries', value: health?.stats.playbookEntries },
    {
      key: 'Error Rate (24h)',
      value:
        typeof health?.slo?.errorRate24h === 'number'
          ? `${(health.slo.errorRate24h * 100).toFixed(2)}%`
          : '-',
    },
  ]

  const statusVariant =
    health?.status === 'healthy'
      ? 'success'
      : health?.status === 'degraded'
        ? 'warning'
        : 'destructive'

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
                <TableHead>Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">Status</TableCell>
                <TableCell>
                  {health?.status ? (
                    <Badge variant={statusVariant}>{health.status}</Badge>
                  ) : (
                    '-'
                  )}
                </TableCell>
              </TableRow>
              {items.map((item) => (
                <TableRow key={item.key}>
                  <TableCell className="font-medium">{item.key}</TableCell>
                  <TableCell>{item.value ?? '-'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
