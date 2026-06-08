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
import { RefreshCw, CheckCircle2, XCircle } from 'lucide-react'

export default function ApprovalsPage() {
  const utils = trpc.useUtils()
  const { data: runs, isLoading, isError, refetch } = trpc.remediation.listRuns.useQuery({ status: 'pending_approval' })

  const approveRun = trpc.remediation.approveRun.useMutation({
    onSuccess: () => {
      toast.success('Run approved and executed')
      utils.remediation.listRuns.invalidate()
    },
    onError: (err) => {
      toast.error(`Failed to approve: ${err.message}`)
    },
  })

  const rejectRun = trpc.remediation.rejectRun.useMutation({
    onSuccess: () => {
      toast.success('Run rejected')
      utils.remediation.listRuns.invalidate()
    },
    onError: (err) => {
      toast.error(`Failed to reject: ${err.message}`)
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground">Loading pending approvals...</p>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load pending approvals.</p>
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
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Review and approve pending remediation actions
        </p>
      </div>

      {!runs || runs.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No pending approvals
          </CardContent>
        </Card>
      ) : (
        <Card>
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
              {runs.map((run) => (
                <TableRow key={run.id as string}>
                  <TableCell className="font-medium">{run.failure_type as string || (run.action_name as string)}</TableCell>
                  <TableCell>{run.action_name as string}</TableCell>
                  <TableCell>{run.affected_resource as string || '-'}</TableCell>
                  <TableCell>
                    {run.severity ? (
                      <Badge
                        variant={
                          run.severity === 'critical' ? 'destructive' :
                          run.severity === 'high' ? 'default' : 'secondary'
                        }
                      >
                        {run.severity as string}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(run.created_at as string).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-green-600 border-green-300 hover:bg-green-50"
                        onClick={() => approveRun.mutate({ id: run.id as string })}
                        disabled={approveRun.isPending}
                      >
                        <CheckCircle2 className="size-3 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-red-600 border-red-300 hover:bg-red-50"
                        onClick={() => rejectRun.mutate({ id: run.id as string })}
                        disabled={rejectRun.isPending}
                      >
                        <XCircle className="size-3 mr-1" />
                        Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  )
}
