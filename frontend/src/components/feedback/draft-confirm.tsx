'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'

// Inline Keep editing / Discard decision for a dirty user-created draft.
// Part of a live region so it is announced rather than silently replacing the
// actions the user was about to take.

export function DraftDiscardConfirm({
  onKeepEditing,
  onDiscard,
}: {
  onKeepEditing: () => void
  onDiscard: () => void
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Discard your answers?"
      className="flex flex-col gap-3 rounded-md border border-border bg-muted/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="text-sm text-muted-foreground">Your answers are not saved yet.</p>
      <div className="flex shrink-0 gap-2">
        <Button variant="ghost" onClick={onKeepEditing} className="min-h-11 sm:min-w-28">
          Keep editing
        </Button>
        <Button variant="destructive" onClick={onDiscard} className="min-h-11 sm:min-w-28">
          Discard
        </Button>
      </div>
    </div>
  )
}
