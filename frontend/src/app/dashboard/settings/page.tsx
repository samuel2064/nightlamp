'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { AlertTriangle, Pencil, Trash2, Plus, KeyRound, Slack, RefreshCw, HardDrive, Globe, GitBranch, type LucideIcon } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTimestamp, formatUtcTimestamp } from '@/lib/format'
import { cn } from '@/lib/utils'

type TabKey = 'apps' | 'checks' | 'notifications' | 'team' | 'billing' | 'integrations'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'apps', label: 'Apps' },
  { key: 'checks', label: 'Checks' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'team', label: 'Team' },
  { key: 'billing', label: 'Billing' },
  { key: 'integrations', label: 'Integrations' },
]

const REFRESH_INTERVAL_MS = 30_000

const statusVariant: Record<string, 'success' | 'warning' | 'destructive' | 'secondary'> = {
  ok: 'success',
  pass: 'success',
  healthy: 'success',
  degraded: 'warning',
  fail: 'destructive',
  critical: 'destructive',
}

export default function SettingsPage() {
  const [tab, setTab] = useState<TabKey>('apps')

  const { data: monitors, isLoading, isError, refetch } = trpc.monitors.list.useQuery(
    undefined,
    { refetchInterval: REFRESH_INTERVAL_MS },
  )
  const [, forceTick] = useState(0)

  // Keep relative "last run" labels ticking.
  useEffect(() => {
    const timer = setInterval(() => forceTick((value) => value + 1), 5_000)
    return () => clearInterval(timer)
  }, [])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex gap-2">
          {TABS.map((t) => (
            <Skeleton key={t.key} className="h-9 w-24" />
          ))}
        </div>
        <Card>
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="ml-auto h-4 w-24" />
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
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage how Nightlamp watches your apps</p>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Couldn&apos;t load settings.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="size-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  const rows = monitors?.monitors ?? []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage how Nightlamp watches your apps</p>
      </div>

      <div role="tablist" aria-label="Settings sections" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            aria-controls={`settings-panel-${t.key}`}
            onClick={() => setTab(t.key)}
            className={cn(
              'rounded-t-md px-3 py-2 text-sm font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
              tab === t.key
                ? 'border-b-2 border-brand text-foreground'
                : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'apps' && (
        <AppsTab rows={rows} />
      )}

      {tab === 'checks' && (
        <div id="settings-panel-checks" role="tabpanel">
          {rows.length === 0 ? (
            <EmptyState
              icon={Plus}
              title="No checks match these filters."
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Checks</CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Check</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Last run</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-medium max-w-0">
                          <span className="block truncate" title={m.id}>{`Check ${m.id.slice(0, 8)}`}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant={statusVariant[m.lastStatus] ?? 'secondary'}>{m.lastStatus || 'unknown'}</Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap" title={formatUtcTimestamp(m.lastRun)}>
                          {relativeTimestamp(m.lastRun)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {tab === 'notifications' && <PanelComing id="settings-panel-notifications">
        <EmptyState
          icon={Slack}
          title="No notification channels connected."
          description="Slack, email, PagerDuty, and webhook channels become available once app integrations are connected."
        />
      </PanelComing>}

      {tab === 'team' && <PanelComing id="settings-panel-team">
        <EmptyState
          icon={Plus}
          title="No team members yet."
          description="Invitations and role management arrive with team accounts."
        />
      </PanelComing>}

      {tab === 'billing' && <PanelComing id="settings-panel-billing">
        <EmptyState
          icon={RefreshCw}
          title="Billing moved to its own page."
          description="Plan details, usage, and the customer portal live on the Billing page."
          action={
            <Link
              href="/dashboard/billing"
              className="inline-flex h-9 items-center justify-center whitespace-nowrap rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent"
            >
              Open Billing
            </Link>
          }
        />
      </PanelComing>}

      {tab === 'integrations' && <IntegrationsTab />}
    </div>
  )
}

function PanelComing({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div id={id} role="tabpanel">
      <Card>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

interface MonitorRow {
  id: string
  name: string
  source: string
  enabled: boolean
  lastStatus: string
  lastRun: string
}

function AppsTab({ rows }: { rows: MonitorRow[] }) {
  return (
    <div id="settings-panel-apps" role="tabpanel">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {rows.length} check source{rows.length === 1 ? '' : 's'} monitored
        </p>
        <Button variant="outline" size="sm" disabled title="App connections arrive with platform integrations">
          <Plus className="size-3 mr-1" /> Add App
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title="No apps monitored yet."
          description="Add your first app to start watching for issues. App connections arrive with platform integrations."
        />
      ) : (
        <div className="space-y-3">
          {rows.map((m) => (
            <Card key={m.id}>
              <CardContent className="flex items-center gap-4 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-medium truncate" title={m.name}>{m.name}</p>
                    <Badge variant="outline" className="shrink-0 text-[10px]">{m.source}</Badge>
                    <Badge variant={m.enabled ? 'success' : 'warning'} className="shrink-0">
                      {m.enabled ? 'Active' : 'Disabled'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground" title={formatUtcTimestamp(m.lastRun)}>
                    Last: {relativeTimestamp(m.lastRun)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" className="size-8" disabled title="Editing arrives with app connections" aria-label={`Edit ${m.name}`}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="size-8" disabled title="Deletion arrives with app connections" aria-label={`Delete ${m.name}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

const INTEGRATIONS: { name: string; icon: LucideIcon; description: string }[] = [
  { name: 'Sentry', icon: AlertTriangle, description: 'Error tracking and release health' },
  { name: 'UptimeRobot', icon: Globe, description: 'External uptime and SSL monitoring' },
  { name: 'GitHub', icon: GitBranch, description: 'Repository and deployment source' },
  { name: 'Railway', icon: HardDrive, description: 'Service platform connection' },
]

function IntegrationsTab() {
  return (
    <div id="settings-panel-integrations" role="tabpanel">
      <div className="grid gap-3 md:grid-cols-2">
        {INTEGRATIONS.map((integration) => {
          const Icon = integration.icon
          return (
            <Card key={integration.name}>
              <CardContent className="flex items-center gap-3 py-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{integration.name}</p>
                  <p className="text-xs text-muted-foreground truncate" title={integration.description}>
                    {integration.description}
                  </p>
                </div>
                <Badge variant="secondary" className="shrink-0">Not connected</Badge>
                <Button variant="outline" size="sm" disabled title="Connect once API keys are configured">
                  Connect
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
      <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
        <KeyRound className="size-3" aria-hidden />
        Connection controls unlock when integration credentials are configured by the operator.
      </p>
    </div>
  )
}
