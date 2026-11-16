'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { trpc } from '@/lib/trpc'
import { toast } from 'sonner'
import { RefreshCw, CheckCircle2, XCircle, ClipboardCheck } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { OfflineBanner } from '@/components/dashboard/OfflineBanner'
import { useLiveConnection } from '@/components/dashboard/connection-indicator'

interface PendingRun {
  id: string
  action_name: string
  status: string
  failure_type?: string | null
  affected_resource?: string | null
  severity?: string | null
  created_at: string
}

export default function ApprovalsPage() {
  const utils = trpc.useUtils()
  const { data: runs, isLoading, isError, error, refetch } = trpc.remediation.listRuns.useQuery({ status: 'pending' })
  const { status: connectionStatus } = useLiveConnection()
  const isOffline = connectionStatus === 'disconnected'

  const approveRun = trpc.remediation.approveRun.useMutation({
    onSuccess: () => {
      toast.success('Run approved and executed')
    },
    onError: (err) => {
      toast.error(`Failed to approve: ${err.message}`)
    },
    onSettled: () => {
      utils.remediation.listRuns.invalidate()
    },
  })

  const rejectRun = trpc.remediation.rejectRun.useMutation({
    onSuccess: () => {
      toast.success('Run rejected')
    },
    onError: (err) => {
      toast.error(`Failed to reject: ${err.message}`)
    },
    onSettled: () => {
      utils.remediation.listRuns.invalidate()
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Card>
          <div className="p-6">
            <div className="space-y-3">
              <div className="flex gap-4 pb-2 border-b">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 flex-1" />
                ))}
              </div>
              {Array.from({ length: 3 }).map((_, r) => (
                <div key={r} className="flex gap-4 py-2">
                  {Array.from({ length: 6 }).map((_, c) => (
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
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">
            Failed to load pending approvals: {error?.message || 'the backend request failed'}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="w-fit">
            <RefreshCw className="size-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  const isMutating = approveRun.isPending || rejectRun.isPending

  return (
    <div className="space-y-6">
      <OfflineBanner onRetry={refetch} />
      <div>
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and approve pending remediation actions
        </p>
      </div>

      {!runs || !runs.runs || runs.runs.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <EmptyState
              icon={ClipboardCheck}
              title="No pending approvals"
              description="There are no remediation actions awaiting approval."
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Failure Type</TableHead>
                <TableHead>Action Name</TableHead>
                <TableHead>Resource</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Detected At</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runs.runs as PendingRun[]).map((run) => (
                <TableRow key={run.id}>
                  <TableCell className="font-medium">{run.failure_type || run.action_name}</TableCell>
                  <TableCell>{run.action_name}</TableCell>
                  <TableCell>{run.affected_resource || '-'}</TableCell>
                  <TableCell>
                    {run.severity ? (
                      <Badge
                        variant={
                          run.severity === 'critical' ? 'destructive' :
                          run.severity === 'high' ? 'default' : 'secondary'
                        }
                      >
                        {run.severity}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(run.created_at).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-green-600 border-green-300 hover:bg-green-50"
                        onClick={() => approveRun.mutate({ id: run.id })}
                        disabled={isMutating || isOffline}
                        aria-disabled={isOffline}
                      >
                        {approveRun.isPending ? <Spinner className="size-3 mr-1" /> : <CheckCircle2 className="size-3 mr-1" />}
                        {isOffline ? 'Offline' : 'Approve'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-300 hover:bg-red-50"
                        onClick={() => rejectRun.mutate({ id: run.id })}
                        disabled={isMutating || isOffline}
                        aria-disabled={isOffline}
                      >
                        {rejectRun.isPending ? <Spinner className="size-3 mr-1" /> : <XCircle className="size-3 mr-1" />}
                        {isOffline ? 'Offline' : 'Reject'}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
            </div>
          </Card>
      )}
    </div>
  )
}
