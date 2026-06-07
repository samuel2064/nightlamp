'use client'

import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { trpc } from '@/lib/trpc'
import { Clock, Activity, AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react'

const typeConfig: Record<string, { icon: LucideIcon; label: string; color: string }> = {
  alert: { icon: AlertTriangle, label: 'Alert', color: 'text-destructive' },
  status: { icon: CheckCircle2, label: 'Status', color: 'text-success' },
  deploy: { icon: RefreshCw, label: 'Update', color: 'text-primary' },
  playbook: { icon: Activity, label: 'Playbook', color: 'text-primary' },
}

const severityBadge: Record<string, { label: string; variant: 'destructive' | 'default' | 'secondary' | 'outline' }> = {
  critical: { label: 'Critical', variant: 'destructive' },
  warning: { label: 'Warning', variant: 'default' },
  info: { label: 'Info', variant: 'secondary' },
  success: { label: 'OK', variant: 'outline' },
}

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

export default function ActivityPage() {
  const { data: logs, isLoading } = trpc.activity.list.useQuery()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Activity Log</h1>
        <p className="text-sm text-muted-foreground mt-1">Real-time event stream</p>
      </div>
      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="alert">Alerts</TabsTrigger>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="playbook">Playbook</TabsTrigger>
        </TabsList>
        {isLoading && (
          <p className="mt-4 text-sm text-muted-foreground">Loading activity...</p>
        )}
        {['all', 'alert', 'status', 'playbook'].map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4">
            <Card>
              <CardContent className="pt-6 space-y-0">
                {!logs || logs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4">No activity events.</p>
                ) : (
                  logs
                    .filter((log) => tab === 'all' || log.type === tab)
                    .map((log) => {
                      const cfg = typeConfig[log.type] ?? typeConfig.status
                      const Icon = cfg.icon
                      const badge = severityBadge[log.severity] ?? severityBadge.info
                      return (
                        <div
                          key={log.id}
                          className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0"
                        >
                          <Icon className={`size-4 mt-0.5 shrink-0 ${cfg.color}`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm">{log.message}</p>
                            <p className="text-xs text-muted-foreground mt-0.5">{log.resource}</p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="size-3" />
                              {timeAgo(log.time)}
                            </span>
                          </div>
                        </div>
                      )
                    })
                )}
              </CardContent>
            </Card>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
