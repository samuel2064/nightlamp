'use client'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { formatDate } from '@/lib/billing'

interface CancelSubscriptionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Local, server-declared period end. The copy never promises a different date. */
  periodEnd: string | null
  pending: boolean
  onConfirm: () => void
}

export function CancelSubscriptionDialog({
  open,
  onOpenChange,
  periodEnd,
  pending,
  onConfirm,
}: CancelSubscriptionDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel your subscription?</AlertDialogTitle>
          <AlertDialogDescription>
            Cancellation takes effect at the end of the current billing period. Your plan and its limits
            stay in force until then. Nightlamp stops monitoring only after that date — nothing is
            cancelled immediately.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <p className="text-sm">
          Access continues until{' '}
          <span className="font-medium">
            {periodEnd ? formatDate(periodEnd) : 'the end of the current billing period'}
          </span>
          .
        </p>

        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11" disabled={pending}>
            Keep my plan
          </AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            className="min-h-11"
            disabled={pending}
            onClick={() => onConfirm()}
          >
            {pending ? 'Scheduling…' : 'Cancel at period end'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}