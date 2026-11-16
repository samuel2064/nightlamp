'use client'

import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, Package, AlertTriangle, ChevronDown, ChevronUp, ChevronRight } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'


export default function DependenciesPage() {
  const [showBreakingOnly, setShowBreakingOnly] = useState(false)
  const { data: deps, isLoading, isError, refetch } = trpc.dependencies.list.useQuery()
  const { data: updates, isLoading: updatesLoading, isError: updatesError } = trpc.dependencies.updates.useQuery({ breakingOnly: showBreakingOnly })

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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dependencies</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Monitored dependencies and available updates
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refetch(); }}
            disabled={isLoading}
          >
            <RefreshCw className={`size-3.5 mr-1 ${isLoading ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </Button>
        </div>
      </div>

      {/* Dependencies List */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
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

      {/* Available Updates */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle>Available Updates</CardTitle>
            {updates?.count && updates.count > 0 && (
              <Badge variant={showBreakingOnly ? 'destructive' : 'default'} className="text-xs">
                {updates.count} update{updates.count !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={showBreakingOnly ? 'default' : 'outline'}
              size="sm"
              onClick={() => setShowBreakingOnly(!showBreakingOnly)}
              className="gap-1"
            >
              <AlertTriangle className="size-3.5" aria-hidden />
              {showBreakingOnly ? 'Show All' : 'Breaking Only'}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {updatesLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div className="space-y-1.5">
                    <Skeleton className="h-4 w-44" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-5 w-20" />
                </div>
              ))}
            </div>
          ) : updatesError ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertTriangle className="size-4" aria-hidden />
              <span>Failed to load updates.</span>
              <Button variant="ghost" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
            </div>
          ) : !updates || updates.updates.length === 0 ? (
            <EmptyState
              icon={Package}
              title={showBreakingOnly ? "No breaking updates" : "No updates available"}
              description={showBreakingOnly
                ? "All dependencies are within their specified ranges."
                : "All dependencies are up to date within their specified ranges."}
            />
          ) : (
            <div className="space-y-2">
              {updates.updates.map((u) => (
                <UpdateRow key={u.id} update={u} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

interface DependencyUpdate {
  id: string
  dependencyId: string
  availableVersion: string
  currentVersion: string
  changeType: string
  isBreaking: boolean
  changelogUrl: string | null
  detectedAt: string
}

function UpdateRow({ update }: { update: DependencyUpdate }) {
  const [expanded, setExpanded] = useState(false)

  const getChangeTypeBadge = () => {
    switch (update.changeType.toLowerCase()) {
      case 'major':
        return <Badge variant="destructive">Major</Badge>
      case 'minor':
        return <Badge variant="default">Minor</Badge>
      case 'patch':
        return <Badge variant="secondary">Patch</Badge>
      default:
        return <Badge variant="outline">{update.changeType}</Badge>
    }
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between p-3 bg-surface-secondary/50">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <p className="font-medium">{update.dependencyId}</p>
            {update.isBreaking && (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="size-3" aria-hidden />
                Breaking
              </Badge>
            )}
            {getChangeTypeBadge()}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right text-sm">
            <p className="font-mono font-medium">{update.currentVersion}</p>
            <p className="text-xs text-muted-foreground">{update.detectedAt}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
          >
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="p-3 border-t bg-background">
          <div className="grid gap-4 sm:grid-cols-3 text-sm">
            <div>
              <p className="text-muted-foreground">Current Version</p>
              <p className="font-mono font-medium">{update.currentVersion}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Available Version</p>
              <p className="font-mono font-medium text-brand">{update.availableVersion}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Change Type</p>
              <p className="font-medium">{update.changeType}</p>
            </div>
          </div>
          {update.changelogUrl && (
            <div className="mt-3">
              <a
                href={update.changelogUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-brand hover:underline"
              >
                View Changelog
                <ChevronRight className="size-3.5" aria-hidden />
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  )
}