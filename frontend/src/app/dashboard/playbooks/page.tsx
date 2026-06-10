'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RefreshCw, BookOpen } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import Link from 'next/link'

export default function PlaybooksPage() {
  const { data, isLoading, isError, refetch } = trpc.playbook.list.useQuery()

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-52" />
        </div>
        <Card>
          <div className="p-6">
            <div className="space-y-3">
              <div className="flex gap-4 pb-2 border-b">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-4 flex-1" />
                ))}
              </div>
              {Array.from({ length: 4 }).map((_, r) => (
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
        <h1 className="text-2xl font-semibold">Playbooks</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load playbooks.</p>
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
        <h1 className="text-2xl font-semibold">Playbooks</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Diagnostic playbook entries
        </p>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Failure Type</TableHead>
              <TableHead>Title</TableHead>
              <TableHead>Occurrences</TableHead>
              <TableHead>First Seen</TableHead>
              <TableHead>Last Occurrence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!data || data.entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-8">
                  <EmptyState
                    icon={BookOpen}
                    title="No playbook entries"
                    description="Diagnostic playbooks will appear here when failures are detected."
                  />
                </TableCell>
              </TableRow>
            ) : (
              data.entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Badge variant="outline">{e.failureType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link href={`/dashboard/playbooks/${e.id}`} className="font-medium hover:underline">
                      {e.title}
                    </Link>
                  </TableCell>
                  <TableCell>{e.occurrenceCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.firstSeenAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.lastOccurrenceAt).toLocaleDateString()}
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
