'use client'

import { Check, Circle, Slash, Save, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import type { Playbook, Step, StepStatus } from './types'

interface StepNavigatorProps {
  playbook: Playbook
  currentIndex: number
  completedIndices: number[]
  skippedIndices: number[]
  onNavigate: (index: number) => void
  onExitSave: () => void
}

function getStepStatus(step: Step, index: number, currentIndex: number, completedIndices: number[], skippedIndices: number[]): StepStatus {
  if (skippedIndices.includes(index)) return 'skipped'
  if (completedIndices.includes(index)) return 'completed'
  if (index === currentIndex) return 'current'
  return 'pending'
}

function getStatusIcon(status: StepStatus) {
  switch (status) {
    case 'completed':
      return <Check className="size-4 text-success" aria-hidden />
    case 'current':
      return <Circle className="size-4 text-info animate-pulse" aria-hidden />
    case 'skipped':
      return <Slash className="size-4 text-muted-foreground" aria-hidden />
    default:
      return <Circle className="size-4 text-muted-foreground" aria-hidden />
  }
}

function getStepTypeBadge(type: Step['type']) {
  const variants: Record<Step['type'], string> = {
    QUESTION: 'bg-info/10 text-info border-info/20',
    CHECK: 'bg-warning/10 text-warning border-warning/20',
    ACTION: 'bg-success/10 text-success border-success/20',
    INFO: 'bg-muted text-muted-foreground',
    BRANCH: 'bg-glow/10 text-glow border-glow/20',
    RESOLUTION: 'bg-success/10 text-success border-success/20',
  }
  return <Badge variant="outline" className={variants[type]}>{type}</Badge>
}

export function StepNavigator({
  playbook,
  currentIndex,
  completedIndices,
  skippedIndices,
  onNavigate,
  onExitSave,
}: StepNavigatorProps) {
  const progress = playbook.steps.length > 0
    ? ((completedIndices.length + (currentIndex < playbook.steps.length ? 1 : 0)) / playbook.steps.length) * 100
    : 0
  const remainingSteps = Math.max(0, playbook.steps.length - currentIndex)

  return (
    <div className="flex h-full w-64 flex-col border-r border-border bg-surface-secondary/40">
      <div className="flex h-14 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-full bg-glow-500">
            <span className="text-xs font-bold text-nightlamp-950">N</span>
          </div>
          <span className="font-semibold tracking-tight">Nightlamp</span>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="border-b border-border p-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold truncate">{playbook.title}</h3>
              {playbook.version && (
                <Badge variant="secondary" className="text-[10px]">
                  v{playbook.version}
                </Badge>
              )}
            </div>
            {(playbook.estimatedDuration !== undefined || playbook.successRate !== undefined) && (
              <div className="text-xs text-muted-foreground">
                {playbook.estimatedDuration !== undefined && `~${playbook.estimatedDuration} min`}
                {playbook.estimatedDuration !== undefined && playbook.successRate !== undefined && ' • '}
                {playbook.successRate !== undefined && `${playbook.successRate}% success`}
              </div>
            )}
            <Progress value={progress} className="h-1.5" />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Step {currentIndex + 1} of {playbook.steps.length}</span>
              <span>{remainingSteps} steps remaining</span>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 p-2">
          <ul className="space-y-1" role="list" aria-label="Playbook steps">
            {playbook.steps.map((step, index) => {
              const status = getStepStatus(step, index, currentIndex, completedIndices, skippedIndices)
              const isClickable = status === 'completed' || status === 'skipped'
              const isCurrent = status === 'current'

              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => isClickable && onNavigate(index)}
                    disabled={!isClickable}
                    aria-current={isCurrent ? 'step' : undefined}
                    aria-disabled={!isClickable}
                    title={!isClickable && index > currentIndex ? 'Complete previous steps first' : undefined}
                    className={cn(
                      'w-full flex items-start gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors text-left',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
                      isCurrent
                        ? 'bg-brand-muted text-brand-hover border-l-[3px] border-brand'
                        : status === 'completed'
                        ? 'text-success hover:bg-success/10'
                        : status === 'skipped'
                        ? 'text-muted-foreground hover:bg-surface-tertiary/50'
                        : 'text-muted-foreground hover:bg-surface-tertiary/50 cursor-not-allowed opacity-60'
                    )}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
                      {getStatusIcon(status)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 truncate">
                        <span className="font-medium truncate">{step.title}</span>
                        {getStepTypeBadge(step.type)}
                      </div>
                      {isCurrent && (
                        <div className="mt-1 flex items-center gap-1 text-xs text-info">
                          <span>Current step</span>
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </ScrollArea>

        <div className="border-t border-border p-3">
          <Button
            variant="outline"
            className="w-full"
            onClick={onExitSave}
          >
            <Save className="size-4 mr-2" aria-hidden />
            Exit & Save
          </Button>
        </div>
      </div>
    </div>
  )
}