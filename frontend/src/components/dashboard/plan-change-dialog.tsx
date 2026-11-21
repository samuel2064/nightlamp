'use client'

import { useState } from 'react'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { formatPlanPrice, formatPeriod } from '@/lib/billing'
import type { BillingPlan } from '@/server/services/backend'

interface PlanChangeDialogProps {
  plans: BillingPlan[]
  currentTier: string
  /** Currency and period declared by the subscription response; never hard-coded here. */
  currency: string
  period: string
  loading: boolean
  error: { title: string; description: string } | null
  pending: boolean
  onConfirm: (planTier: string) => void
}

export function PlanChangeDialog({
  plans,
  currentTier,
  currency,
  period,
  loading,
  error,
  pending,
  onConfirm,
}: PlanChangeDialogProps) {
  const [selectedTier, setSelectedTier] = useState(currentTier)

  const currentPlan = plans.find((plan) => plan.id === currentTier)
  const selectedPlan = plans.find((plan) => plan.id === selectedTier)
  const changed = selectedTier !== currentTier

  return (
    <AlertDialog
      onOpenChange={(next) => {
        // The selection resets to the server-declared current tier each time
        // the dialog opens, so a stale choice never survives a reopen.
        if (next) setSelectedTier(currentTier)
      }}
    >
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="min-h-11" disabled={pending}>
          Change plan
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change plan</AlertDialogTitle>
          <AlertDialogDescription>
            Choose a plan and confirm. The billing service applies the change and returns the new plan;
            the page updates only from that reply.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {loading ? (
          <Skeleton className="h-10 w-full" />
        ) : error ? (
          <div className="space-y-1">
            <p className="text-sm font-medium text-destructive">{error.title}</p>
            <p className="text-sm text-muted-foreground">{error.description}</p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="plan-tier">Plan</Label>
            {/* Plan ids and names are both server-declared; no tier is hard-coded here. */}
            <Select
              value={selectedTier}
              onValueChange={setSelectedTier}
              disabled={pending || plans.length === 0}
            >
              <SelectTrigger id="plan-tier" className="min-h-11 text-base">
                <SelectValue placeholder="Select a plan" />
              </SelectTrigger>
              <SelectContent>
                {plans.map((plan) => (
                  <SelectItem key={plan.id} value={plan.id} className="min-h-11">
                    {plan.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                The billing service returned no plans, so no change can be offered.
              </p>
            ) : (
              <ul className="space-y-1 pt-1">
                {plans.map((plan) => (
                  <li key={plan.id} className="text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{plan.name}</span>
                    {' — '}
                    {formatPlanPrice(plan.price, currency)}
                    {formatPeriod(period) ? ` ${formatPeriod(period)}` : ''}
                    {' · '}
                    {plan.monitors} monitors · {plan.reports} reports · {plan.storageMb} MB storage
                  </li>
                ))}
              </ul>
            )}
            {changed && selectedPlan && (
              <p className="text-sm">
                Change from{' '}
                <span className="font-medium">{currentPlan?.name ?? currentTier}</span> to{' '}
                <span className="font-medium">{selectedPlan.name}</span>. Limits and price change
                immediately after the billing service accepts.
              </p>
            )}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel className="min-h-11" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          {!loading && !error && plans.length > 0 && (
            <Button
              type="button"
              className="min-h-11"
              disabled={pending || !changed}
              onClick={() => onConfirm(selectedTier)}
            >
              {pending ? 'Applying…' : 'Confirm plan change'}
            </Button>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
