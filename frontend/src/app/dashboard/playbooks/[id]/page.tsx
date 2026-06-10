'use client'

import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { RefreshCw, ArrowLeft } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import Link from 'next/link'
import { useParams } from 'next/navigation'

export default function PlaybookDetailPage() {
  const params = useParams()
  const id = params.id as string
  const { data: entry, isLoading, isError, refetch } = trpc.playbook.get.useQuery({ id })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Link href="/dashboard/playbooks" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="size-3" /> Back to Playbooks
        </Link>
        <div className="space-y-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-8 w-72" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-6 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </CardContent>
        </Card>
      </div>
    )
  }

  if (isError || !entry) {
    return (
      <div className="space-y-6">
        <Link href="/dashboard/playbooks" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="size-3" /> Back to Playbooks
        </Link>
        <h1 className="text-2xl font-semibold">Playbook Entry</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load playbook entry.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="size-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Link href="/dashboard/playbooks" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
        <ArrowLeft className="size-3" /> Back to Playbooks
      </Link>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="outline">{entry.failureType}</Badge>
          <span className="text-xs text-muted-foreground">{entry.occurrenceCount} occurrences</span>
        </div>
        <h1 className="text-2xl font-semibold">{entry.title}</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">First Seen</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{new Date(entry.firstSeenAt).toLocaleDateString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Last Occurrence</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{new Date(entry.lastOccurrenceAt).toLocaleDateString()}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Total Occurrences</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{entry.occurrenceCount}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
