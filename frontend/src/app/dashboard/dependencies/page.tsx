'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, Package } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'

export default function DependenciesPage() {
  const { data: deps, isLoading, isError, refetch } = trpc.dependencies.list.useQuery()

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-4 w-60" />
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-3 w-32" />
                  </div>
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
        <h1 className="text-2xl font-semibold">Dependencies</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load dependencies.</p>
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
        <h1 className="text-2xl font-semibold">Dependencies</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monitored dependencies and available updates
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Dependencies ({deps?.count ?? 0})</CardTitle>
        </CardHeader>
        <CardContent>
          {!deps || deps.dependencies.length === 0 ? (
            <EmptyState
              icon={Package}
              title="No dependencies tracked"
              description="Add dependencies to start monitoring for updates."
            />
          ) : (
            <div className="space-y-2">
              {deps.dependencies.map((d) => (
                <div key={d.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div>
                    <p className="font-medium">{d.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {d.currentVersion} ({d.specifiedRange})
                      {d.isDev && <Badge variant="outline" className="ml-2 text-[10px]">dev</Badge>}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
