'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SurveyInterior } from './survey-surface'
import { useDraftGuard } from './use-durable-submission'
import { DraftDiscardConfirm } from './draft-confirm'
import type { SurveyAnswers, SurveyDefinition } from '@/lib/feedback/survey-definitions'

// Modal survey surface (welcome, NPS, exit). Radix Dialog supplies the
// accessible dialog name, focus containment, Escape and focus return.
//
// Mobile contract (NOC-161 2026-11-16 addendum):
// - content-height sheet capped by the viewport, body scrolls, submit/dismiss
//   stay visible with the keyboard open
// - 320/375px without clipping or page-level horizontal overflow
// - safe-area padding at the bottom, reduced-motion honoured

export interface SurveyModalProps {
  definition: SurveyDefinition
  open: boolean
  onDismiss: () => void
  onSent?: () => void
  idPrefix?: string
}

export function SurveyModal({ definition, open, onDismiss, onSent, idPrefix = 'survey' }: SurveyModalProps) {
  const [answers, setAnswers] = React.useState<SurveyAnswers>({})
  const guard = useDraftGuard(onDismiss)

  // A dismissed or completed survey must not reopen with the previous answers.
  React.useEffect(() => {
    if (!open) setAnswers({})
  }, [open, definition.id])

  return (
    <Dialog
      open={open}
      // Escape, overlay click and the close button are dismissals, never
      // completions, and never block monitoring. A dirty draft is confirmed
      // before it is thrown away.
      onOpenChange={(next) => {
        if (!next) guard.requestClose()
      }}
    >
      <DialogContent className={SURFACE_SHEET_CLASS} aria-describedby={undefined}>
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle className="pr-8 text-lg">{definition.title}</DialogTitle>
          {definition.description ? (
            <DialogDescription className="text-base">{definition.description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {guard.confirming ? (
            <DraftDiscardConfirm onKeepEditing={guard.keepEditing} onDiscard={guard.discardNow} />
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
      </DialogContent>
    </Dialog>
  )
}

// Content height capped by the viewport; never a fixed 25% sheet height.
export const SURFACE_SHEET_CLASS = [
  'flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg',
  'motion-reduce:animate-none',
].join(' ')
