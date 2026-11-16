'use client'

import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'

export interface MetricCardProps {
  label: string
  value: string | number | null
  icon: React.ReactNode
  trend?: { value: number; label: string }
  destructive?: boolean
}

export function MetricCard({ label, value, icon, trend, destructive }: MetricCardProps) {
  return (
    <Card className="p-4">
      <CardContent className="py-0 space-y-2">
        <div className={cn('size-5', destructive ? 'text-destructive' : 'text-glow-500')}>
          {icon}
        </div>
        <p className={cn('text-3xl font-bold tabular-nums', destructive && 'text-destructive')}>
          {value ?? '—'}
        </p>
        <p className="text-sm text-muted-foreground">{label}</p>
        {trend && (
          <p className={cn('text-sm flex items-center gap-1', trend.value >= 0 ? 'text-success' : 'text-destructive')}>
            {trend.value >= 0 ? '↑' : '↓'} {Math.abs(trend.value)}% {trend.label}
          </p>
        )}
      </CardContent>
    </Card>
  )
}