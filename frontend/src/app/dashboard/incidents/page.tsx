'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'

export default function IncidentsPage() {
  const { data, isLoading, isError, refetch } = trpc.incidents.list.useQuery({ limit: 100 })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Card>
          <div className="p-6">
            <div className="space-y-3">
              <div className="flex gap-4 pb-2 border-b">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 flex-1" />
                ))}
              </div>
              {Array.from({ length: 6 }).map((_, r) => (
                <div key={r} className="flex gap-4 py-2">
                  {Array.from({ length: 5 }).map((_, c) => (
                    <Skeleton key={c} className="h-4 flex-1" />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </Card>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Incidents</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load incidents.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="size-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Incidents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Failure events and alerts
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead>Acknowledged</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data || data.events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <EmptyState
                    icon={AlertTriangle}
                    title="No incidents found"
                    description="All systems are operating normally."
                  />
                </TableCell>
              </TableRow>
            ) : (
              data.events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Badge
                      variant={
                        e.severity === 'critical' ? 'destructive' :
                        e.severity === 'high' ? 'default' : 'secondary'
                      }
                    >
                      {e.severity}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-medium">{e.title}</TableCell>
                  <TableCell>{e.failureType}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.detectedAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {e.acknowledged ? (
                      <Badge variant="secondary">Acknowledged</Badge>
                    ) : (
                      <Badge variant="outline">Unacknowledged</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  )
}
