'use client'

import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Sparkline } from './sparkline'
import { relativeTimestamp, formatUtcTimestamp } from '@/lib/format'

interface AppHealthCardProps {
  name: string
  health: number
  status: 'healthy' | 'degraded' | 'critical'
  sparkline: number[]
  lastCheck: string
  onClick: () => void
}

const statusConfig = {
  healthy: { variant: 'success' as const, label: 'Healthy' },
  degraded: { variant: 'warning' as const, label: 'Degraded' },
  critical: { variant: 'destructive' as const, label: 'Critical' },
}

export function AppHealthCard({ name, health, status, sparkline, lastCheck, onClick }: AppHealthCardProps) {
  const config = statusConfig[status]
  const sparklineColor = status === 'healthy' ? 'success' : status === 'degraded' ? 'warning' : 'error'

  return (
    <Card
      onClick={onClick}
      className={cn(
        'cursor-pointer transition-all hover:border-glow-500/60',
        'focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary',
        'p-4'
      )}
    >
      <CardContent className="py-0 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-medium" title={name}>
            {name}
          </span>
          <Badge variant={config.variant}>
            {config.label}
          </Badge>
        </div>
        <Sparkline data={sparkline} color={sparklineColor} className="h-12" />
        <p className="text-xs text-muted-foreground">
          Last check: {relativeTimestamp(lastCheck)} ·{' '}
          <span title={formatUtcTimestamp(lastCheck)}>
            {formatUtcTimestamp(lastCheck)}
          </span>
        </p>
      </CardContent>
    </Card>
  )
}