'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Search } from 'lucide-react'
import { trpc } from '@/lib/trpc'

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export default function IncidentsPage() {
  const { data: incidents, isLoading } = trpc.incident.list.useQuery()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Incidents</h1>
        <p className="text-sm text-muted-foreground mt-1">Track and manage incidents</p>
      </div>
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input placeholder="Search incidents..." className="pl-9" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">All Incidents</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading incidents...</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">ID</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Title</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Resource</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Severity</th>
                  <th className="text-left text-xs font-medium text-muted-foreground pb-3">Status</th>
                  <th className="text-right text-xs font-medium text-muted-foreground pb-3">Time</th>
                </tr>
              </thead>
              <tbody>
                {incidents?.map((inc) => (
                  <tr key={inc.id} className="border-b border-border/50 last:border-0">
                    <td className="py-3 text-sm font-mono">{inc.id}</td>
                    <td className="py-3 text-sm">{inc.title}</td>
                    <td className="py-3 text-sm text-muted-foreground">{inc.resource}</td>
                    <td className="py-3">
                      <Badge
                        variant={
                          inc.severity === 'critical' ? 'destructive' :
                          inc.severity === 'high' ? 'default' : 'secondary'
                        }
                      >
                        {inc.severity}
                      </Badge>
                    </td>
                    <td className="py-3 text-sm capitalize">{inc.status}</td>
                    <td className="py-3 text-sm text-muted-foreground text-right">{timeAgo(inc.time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
