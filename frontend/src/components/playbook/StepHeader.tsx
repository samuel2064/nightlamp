'use client'

import { Badge } from '@/components/ui/badge'
import type { Step } from './types'

interface StepHeaderProps {
  stepNumber: number
  totalSteps: number
  title: string
  type: Step['type']
}

const TYPE_BADGE_VARIANTS: Record<Step['type'], string> = {
  QUESTION: 'bg-info/10 text-info border-info/20',
  CHECK: 'bg-warning/10 text-warning border-warning/20',
  ACTION: 'bg-success/10 text-success border-success/20',
  INFO: 'bg-muted text-muted-foreground',
  BRANCH: 'bg-glow/10 text-glow border-glow/20',
  RESOLUTION: 'bg-success/10 text-success border-success/20',
}

export function StepHeader({ stepNumber, totalSteps, title, type }: StepHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-4 mb-6 pb-4 border-b border-border">
      <div>
        <p className="text-lg font-semibold">
          Step {stepNumber} of {totalSteps}: {title}
        </p>
      </div>
      <Badge variant="outline" className={TYPE_BADGE_VARIANTS[type]}>
        {type}
      </Badge>
    </div>
  )
}