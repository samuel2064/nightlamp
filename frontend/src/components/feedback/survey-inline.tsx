'use client'

import * as React from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SurveyInterior } from './survey-surface'
import { useDraftGuard } from './use-durable-submission'
import { DraftDiscardConfirm } from './draft-confirm'
import { restoredAnswers } from '@/lib/feedback/draft'
import type { SurveyAnswers, SurveyDefinition } from '@/lib/feedback/survey-definitions'

// Inline microsurvey surface (contextual, automatic prompts).
//
// Contract (NOC-161 2026-11-16 addendum):
// - non-modal: no overlay, no focus trap, no focus theft. The prompt is
//   announced politely; keyboard and screen-reader users reach it by tabbing.
// - content-driven height capped by the available viewport; the body scrolls
//   and submit/dismiss stay visible with the keyboard open
// - 320/375px without clipping or page-level horizontal overflow; clears the
//   bottom navigation and safe-area insets

export interface MicrosurveyInlineProps {
  definition: SurveyDefinition
  open: boolean
  onDismiss: () => void
  onSent?: () => void
  idPrefix?: string
}

export function MicrosurveyInline({
  definition,
  open,
  onDismiss,
  onSent,
  idPrefix = 'microsurvey',
}: MicrosurveyInlineProps) {
  const [answers, setAnswers] = React.useState<SurveyAnswers>({})

  // Resume the session draft on open so a remount does not lose the answers or
  // the response_id bound to them.
  React.useEffect(() => {
    if (open) setAnswers(restoredAnswers('survey', definition.id))
  }, [open, definition.id])

  const guard = useDraftGuard(onDismiss)

  // Escape dismisses without moving focus anywhere it was not already, and it
  // goes through the same dirty-draft guard as the close button: a dirty draft
  // is confirmed before it is thrown away.
  React.useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') guard.requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, guard])

  return (
    <section
      aria-label={definition.title}
      aria-live="polite"
      data-testid="microsurvey-inline"
      className={[
        'fixed inset-x-2 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-40 mx-auto w-[calc(100vw-1rem)] max-w-md',
        'flex max-h-[calc(100dvh-7rem)] flex-col gap-0 overflow-hidden rounded-xl border border-border bg-card p-0 shadow-elevation-3',
        'sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-96',
        'motion-reduce:animate-none',
      ].join(' ')}
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border px-4 py-3">
        <h2 className="flex-1 pr-2 text-base font-semibold leading-snug">{definition.title}</h2>
        <Button
          variant="ghost"
          size="icon"
          className="size-11 shrink-0"
          onClick={guard.requestClose}
          aria-label="Dismiss survey"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {guard.confirming ? (
          <div className="mb-4">
            <DraftDiscardConfirm onKeepEditing={guard.keepEditing} onDiscard={guard.discardNow} />
          </div>
        ) : null}
        <SurveyInterior
          definition={definition}
          answers={answers}
          onAnswersChange={setAnswers}
          onDismiss={guard.requestClose}
          onSent={onSent}
          idPrefix={`${idPrefix}-${definition.id}`}
        />
      </div>
    </section>
  )
}
