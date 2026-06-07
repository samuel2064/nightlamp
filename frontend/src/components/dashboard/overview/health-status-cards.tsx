'use client'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'

export function HealthStatusCards() {
  const { data } = trpc.monitor.health.useQuery(undefined, { retry: false })

  const up = data?.monitors.filter((m) => m.status === 'up').length ?? 0
  const degraded = data?.monitors.filter((m) => m.status === 'degraded').length ?? 0
  const down = data?.monitors.filter((m) => m.status === 'down').length ?? 0

  const statuses = [
    { label: 'Operational', count: up, color: 'bg-success', severity: 'low' as const },
    { label: 'Degraded', count: degraded, color: 'bg-warning', severity: 'medium' as const },
    { label: 'Down', count: down, color: 'bg-destructive', severity: 'critical' as const },
  ]

  return (
    <div className="grid grid-cols-3 gap-4">
      {statuses.map((s) => (
        <Card key={s.label}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <span className={cn('size-3 rounded-full', s.color)} />
              <span className="text-2xl font-bold">{s.count}</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
