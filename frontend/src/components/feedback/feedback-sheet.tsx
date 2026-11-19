'use client'

import * as React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { FeedbackSurface } from './feedback-form'
import { SURFACE_SHEET_CLASS } from './survey-modal'
import { useDraftGuard } from './use-durable-submission'
import { DraftDiscardConfirm } from './draft-confirm'
import { restoredAnswers } from '@/lib/feedback/draft'
import { feedbackDefinitionFor, type FeedbackValues } from '@/lib/feedback/feedback-definitions'
import type { FeedbackType } from '@/lib/feedback/contract'

// User-initiated feedback surface: bug_report, feature_request and general.
// It stays available even while automatic prompts are suppressed, because a
// founder reporting a problem must never wait for the scheduler.

export interface FeedbackSheetProps {
  type: FeedbackType
  open: boolean
  onClose: () => void
  idPrefix?: string
}

export function FeedbackSheet({ type, open, onClose, idPrefix = 'feedback' }: FeedbackSheetProps) {
  const [values, setValues] = React.useState<FeedbackValues>({})
  const definition = feedbackDefinitionFor(type)

  // Resume the session draft on open so a remount (authentication expiry,
  // navigation back) does not lose the answers or their response_id.
  React.useEffect(() => {
    if (open && definition) setValues(restoredAnswers('feedback', definition.feedback_type))
  }, [open, type, definition])

  const guard = useDraftGuard(onClose)

  if (!definition || !open) return null

  return (
    <Dialog
      open={open}
      // Escape, overlay click and the close button are dismissals: the draft
      // stays in memory and is offered again on the next open.
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
          <FeedbackSurface
            definition={definition}
            values={values}
            onValuesChange={setValues}
            idPrefix={`${idPrefix}-${type}`}
            onCancel={guard.requestClose}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
