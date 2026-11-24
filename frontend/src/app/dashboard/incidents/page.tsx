'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { RefreshCw, CheckCircle2 } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { toast } from 'sonner'
import { OfflineBanner } from '@/components/dashboard/OfflineBanner'
import { useLiveConnection } from '@/components/dashboard/connection-indicator'
import { useSurveyTrigger } from '@/components/feedback/survey-provider'

export default function IncidentsPage() {
  const utils = trpc.useUtils()
  const surveyTrigger = useSurveyTrigger()
  const { data, isLoading, isError, refetch } = trpc.incidents.list.useQuery({ limit: 100 })
  const { status: connectionStatus } = useLiveConnection()
  const isOffline = connectionStatus === 'disconnected'

  const acknowledgeIncident = trpc.incidents.acknowledge.useMutation({
    onMutate: async ({ id }) => {
      await utils.incidents.list.cancel()
      const prev = utils.incidents.list.getData({ limit: 100 })
      if (prev?.events) {
        utils.incidents.list.setData({ limit: 100 }, {
          ...prev,
          events: prev.events.map((e) =>
            e.id === id ? { ...e, acknowledged: true } : e,
          ),
        })
      }
      return { prev }
    },
    onSuccess: () => {
      toast.success('Incident acknowledged')
      // Durable acknowledgement is the successful action behind the alert
      // usefulness microsurvey; the scheduler still suppresses it while a
      // critical alert or an active incident response is open.
      surveyTrigger.alertReceived()
    },
    onError: (err, { id }, context) => {
      if (context?.prev) {
        utils.incidents.list.setData({ limit: 100 }, context.prev)
      }
      toast.error(`Failed to acknowledge incident: ${err.message}`)
    },
    onSettled: () => {
      utils.incidents.list.invalidate()
    },
  })

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
      <OfflineBanner onRetry={refetch} />
      <div>
        <h1 className="text-2xl font-semibold">Incidents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Failure events and alerts
        </p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Severity</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead>Acknowledged</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data || data.events.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8">
                  <EmptyState
                    icon={CheckCircle2}
                    title="No incidents — everything is healthy."
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
                  <TableCell className="text-right">
                    {!e.acknowledged && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => acknowledgeIncident.mutate({ id: e.id })}
                        disabled={acknowledgeIncident.isPending || isOffline}
                        aria-label={`Acknowledge ${e.title}`}
                        aria-disabled={isOffline}
                      >
                        {acknowledgeIncident.isPending ? (
                          <Spinner className="size-3 mr-1" />
                        ) : (
                          <CheckCircle2 className="size-3 mr-1" />
                        )}
                        {isOffline ? 'Offline' : 'Acknowledge'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        </div>
      </Card>
    </div>
  )
}
