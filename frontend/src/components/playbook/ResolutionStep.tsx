'use client'

import { CheckCircle2, AlertCircle, FileText, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

interface ResolutionStepProps {
  outcome: 'success' | 'partial' | 'escalation'
  rootCause: string
  actionsTaken: string[]
  prevention: string[]
  onExport: () => void
  onMarkResolved: () => void
  onPostMortem: () => void
  onClose: () => void
  disabled?: boolean
}

const OUTCOME_CONFIG = {
  success: {
    label: 'Issue Resolved!',
    description: 'The issue has been successfully resolved.',
    icon: CheckCircle2,
    iconColor: 'text-success',
    badgeVariant: 'success' as const,
  },
  partial: {
    label: 'Workaround Applied',
    description: 'A temporary workaround has been applied. Monitor for recurrence.',
    icon: AlertCircle,
    iconColor: 'text-warning',
    badgeVariant: 'warning' as const,
  },
  escalation: {
    label: 'Escalated',
    description: 'The issue has been escalated for further investigation.',
    icon: AlertCircle,
    iconColor: 'text-destructive',
    badgeVariant: 'destructive' as const,
  },
}

export function ResolutionStep({
  outcome,
  rootCause,
  actionsTaken,
  prevention,
  onExport,
  onMarkResolved,
  onPostMortem,
  onClose,
  disabled,
}: ResolutionStepProps) {
  const config = OUTCOME_CONFIG[outcome]
  const Icon = config.icon

  return (
    <div className="space-y-6">
      <div className="text-center py-8">
        <Icon className={cn('size-12 mx-auto mb-4', config.iconColor)} aria-hidden />
        <h2 className="text-2xl font-bold">{config.label}</h2>
        <p className="text-muted-foreground mt-1">{config.description}</p>
        <Badge variant={config.badgeVariant} className="mt-4 capitalize">
          {outcome}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Root Cause</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-foreground">{rootCause}</p>
        </CardContent>
      </Card>

      {actionsTaken.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CheckCircle2 className="size-5 text-success" aria-hidden />
              Actions Taken
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {actionsTaken.map((action, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-success/10 text-success text-sm font-medium">
                    {i + 1}
                  </span>
                  <span className="pt-1">{action}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      {prevention.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Lightbulb className="size-5 text-glow-500" aria-hidden />
              Prevention
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {prevention.map((item, i) => (
                <li key={i} className="flex items-start gap-2 text-sm">
                  <Lightbulb className="size-4 shrink-0 text-glow-500 mt-0.5" aria-hidden />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2 justify-between pt-4 border-t border-border">
        <div className="flex gap-2">
          <Button variant="outline" onClick={onExport} disabled={disabled} className="gap-2">
            <FileText className="size-4" aria-hidden />
            Export Report
          </Button>
          {outcome !== 'escalation' && (
            <Button variant="outline" onClick={onPostMortem} disabled={disabled} className="gap-2">
              <RefreshCw className="size-4" aria-hidden />
              Run Post-Mortem
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {outcome !== 'escalation' && (
            <Button onClick={onMarkResolved} disabled={disabled} className="gap-2">
              Mark Resolved
              <CheckCircle2 className="size-4" aria-hidden />
            </Button>
          )}
          <Button variant="outline" onClick={onClose} disabled={disabled} className="gap-2">
            <X className="size-4" aria-hidden />
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}