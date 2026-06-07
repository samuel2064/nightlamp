'use client'

import { useParams, useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ArrowLeft, Clock } from 'lucide-react'
import { trpc } from '@/lib/trpc'

export default function PlaybookDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = Number(params.id)
  const { data: entry, isLoading } = trpc.playbook.get.useQuery({ id })

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>
  }

  if (!entry) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft className="size-4 mr-1" /> Back
        </Button>
        <p className="text-sm text-muted-foreground">Playbook entry not found.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <Button variant="ghost" size="sm" onClick={() => router.back()}>
        <ArrowLeft className="size-4 mr-1" /> Back
      </Button>

      <div>
        <div className="flex items-center gap-2 mb-2">
          <Badge
            variant={entry.severity === 'critical' ? 'destructive' : entry.severity === 'high' ? 'default' : 'secondary'}
          >
            {entry.severity}
          </Badge>
          <Badge variant="outline" className="capitalize">{entry.status}</Badge>
          {entry.resolvedAt && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="size-3" />
              Resolved {new Date(entry.resolvedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <h1 className="text-xl font-semibold">{entry.title}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {entry.affectedResource} &middot; {entry.failureType}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Diagnosis</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{entry.diagnosis || 'No diagnosis recorded'}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Remediation Steps</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-sans">
            {entry.remediation || 'No remediation steps recorded'}
          </pre>
        </CardContent>
      </Card>

      {entry.relatedEntries && (
        <div>
          <p className="text-xs text-muted-foreground">Related entries: {entry.relatedEntries}</p>
        </div>
      )}
    </div>
  )
}
