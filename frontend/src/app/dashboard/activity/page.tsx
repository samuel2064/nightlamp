'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, Activity as ActivityIcon } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'

export default function ActivityPage() {
  const { data, isLoading, isError, refetch } = trpc.activity.list.useQuery({ limit: 100 })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-4 w-44" />
        </div>
        <Card>
          <CardContent className="pt-6">
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2 border-b last:border-0">
                  <Skeleton className="h-5 w-16 shrink-0" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-3 w-28 shrink-0" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Activity</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load activity.</p>
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
        <h1 className="text-2xl font-semibold">Activity</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Recent system activity
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          {!data || data.activity.length === 0 ? (
            <EmptyState
              icon={ActivityIcon}
              title="No activity recorded"
              description="System activity will appear here."
            />
          ) : (
            <div className="space-y-1">
              {data.activity.map((a) => (
                <div key={a.id} className="flex items-start gap-3 py-2 text-sm border-b last:border-0">
                  <div className="flex items-center gap-2 shrink-0 w-24">
                    <Badge variant="outline" className="text-[10px] uppercase">{a.type}</Badge>
                  </div>
                  <span className="flex-1">{a.summary}</span>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {new Date(a.timestamp).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
