'use client'

import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSurveySurfaces } from './survey-provider'

// Optional welcome survey invitation, shown before the first monitor.
//
// Contract (NOC-161 2026-11-16 addendum): welcome keeps to segmentation only,
// Skip starts setup immediately, and dismissal never prevents monitoring. The
// invitation is user-initiated, so it is never suppressed by the scheduler.

export interface WelcomeSurveyInvitationProps {
  /** Skip: starts setup immediately. */
  onSkipToSetup: () => void
}

export function WelcomeSurveyInvitation({ onSkipToSetup }: WelcomeSurveyInvitationProps) {
  const { openSurvey } = useSurveySurfaces()

  return (
    <div className="rounded-lg border border-border bg-surface-primary/60 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Before you start</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Three quick questions, under a minute. Optional — your monitoring is ready either way.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <Button variant="ghost" onClick={onSkipToSetup} className="min-h-11 sm:min-w-32">
            Skip, add my first app
          </Button>
          <Button onClick={() => openSurvey('welcome')} className="min-h-11 gap-2 sm:min-w-32">
            <MessageSquarePlus className="size-4" aria-hidden />
            Answer
          </Button>
        </div>
      </div>
    </div>
  )
}
