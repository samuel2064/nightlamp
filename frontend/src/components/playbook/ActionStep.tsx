'use client'

import { useState } from 'react'
import { ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog'
import type { ReactNode } from 'react'

interface ActionStepProps {
  instructions: string
  confirmLabel: string
  requireConfirmation: boolean
  onComplete: () => void
  onPrevious: () => void
  disabled?: boolean
}

function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-invert max-w-none">
      {content.split('\n').map((line, i) => (
        <p key={i} className="whitespace-pre-wrap">{line}</p>
      ))}
    </div>
  )
}

export function ActionStep({
  instructions,
  confirmLabel,
  requireConfirmation,
  onComplete,
  onPrevious,
  disabled,
}: ActionStepProps) {
  const [confirmed, setConfirmed] = useState(false)

  const handleComplete = () => {
    if (requireConfirmation) {
      // The AlertDialog will handle confirmation
    } else {
      onComplete()
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-4">
          <MarkdownRenderer content={instructions} />
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 p-4 bg-surface-tertiary/50 rounded-lg border border-border">
        <Checkbox
          id="action-confirmed"
          checked={confirmed}
          onCheckedChange={(checked) => setConfirmed(checked as boolean)}
          disabled={disabled}
          aria-label="I have completed this step"
        />
        <Label htmlFor="action-confirmed" className="text-sm font-medium cursor-pointer flex-1">
          I have completed this step
        </Label>
      </div>

      <div className="flex justify-between pt-4 border-t border-border">
        <Button variant="outline" onClick={onPrevious} disabled={disabled}>
          Previous
        </Button>
        <div className="ml-auto">
          {requireConfirmation ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  onClick={() => setConfirmed(true)}
                  disabled={disabled || !confirmed}
                  className="gap-2"
                >
                  {confirmLabel}
                  <ChevronRight className="size-4" aria-hidden />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Confirm completion</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to mark this step as complete? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="flex justify-end gap-2">
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onComplete} disabled={disabled}>
                    Yes, mark complete
                  </AlertDialogAction>
                </div>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <Button
              onClick={handleComplete}
              disabled={disabled || !confirmed}
              className="gap-2"
            >
              {confirmLabel}
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}