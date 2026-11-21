'use client'

import { useMemo } from 'react'
import { trpc } from '@/lib/trpc'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/ui/empty-state'
import { toast } from 'sonner'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileText,
  Lock,
  RefreshCw,
} from 'lucide-react'
import {
  accessLevelFor,
  formatDate,
  formatInvoiceAmount,
  formatInvoiceDate,
  formatPlanPrice,
  formatPeriod,
  formatUsageValue,
  hasRenderableInvoiceLink,
  hasScheduledCancellation,
  isSafeInvoiceUrl,
  mutationOutcomeFor,
  subscriptionActionable,
  subscriptionLevelFor,
  usageRows,
  type AccessLevel,
  type SubscriptionLevel,
} from '@/lib/billing'
import { PlanChangeDialog } from '@/components/dashboard/plan-change-dialog'
import { CancelSubscriptionDialog } from '@/components/dashboard/cancel-subscription-dialog'
import type { BillingRole } from '@/server/services/backend'

type BillingTRPCError = { data?: { code?: string } }

type BadgeTone = 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' | 'outline'

function errorCodeOf(err: unknown): string {
  // The browser receives the serialized tRPC error (`data.code`); a raw
  // TRPCError carries `.code`. Both are read so the mapping holds either way.
  const raw = err as (BillingTRPCError & { code?: string }) | null
  const code = typeof raw?.data?.code === 'string' ? raw.data.code : raw?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

const SUBSCRIPTION_COPY: Record<SubscriptionLevel, { label: string; tone: BadgeTone; note: string | null }> = {
  none: { label: 'No active plan', tone: 'secondary', note: null },
  active: { label: 'Active', tone: 'success', note: null },
  trialing: { label: 'Trial', tone: 'info', note: 'Your trial is running. Add a payment method before the trial ends to keep monitoring on.' },
  scheduled_cancel: { label: 'Cancellation scheduled', tone: 'warning', note: 'Your plan is set to end at the close of the current billing period.' },
  past_due: { label: 'Past due', tone: 'destructive', note: 'Payment is past due. Update your payment method in the Stripe portal to keep monitoring active.' },
  canceled: {
    label: 'Canceled',
    tone: 'secondary',
    note: 'This subscription is canceled. It is not billed, and no new period is scheduled. The details below are the last state the billing service reported.',
  },
  incomplete: {
    label: 'Payment incomplete',
    tone: 'warning',
    note: 'The last payment attempt did not complete, so this subscription is not active. Finish it in the Stripe portal.',
  },
  unknown: {
    label: 'Status reported by the server',
    tone: 'secondary',
    note: 'The billing service reported a status this page does not recognise. The details below are the last state it declared.',
  },
}

const READ_COPY: Record<string, { title: string; description: string }> = {
  UNAUTHORIZED: {
    title: 'Sign in to view billing',
    description: 'Your session is not authenticated. Sign in again to load your plan, usage and invoices.',
  },
  FORBIDDEN: {
    title: 'Billing is not available for this account',
    description: 'The billing service refused this request for the signed-in account.',
  },
  NOT_FOUND: {
    title: 'No billing record for this account',
    description: 'The billing service has no record for the signed-in account yet.',
  },
  SERVICE_UNAVAILABLE: {
    title: 'Billing service unavailable',
    description: 'The billing service did not answer. Nothing on this page should be read as a current plan or amount.',
  },
  INTERNAL_SERVER_ERROR: {
    title: 'Billing reported a failure',
    description:
      'The billing service returned a failure response while handling this request. Nothing on this page should be read as a current plan or amount. Retry, and contact support if it persists.',
  },
}

const READ_FALLBACK = {
  title: 'Billing could not be loaded',
  description: 'The billing service returned an unexpected response. Retry, and contact support if it persists.',
}

function readError(err: unknown) {
  return READ_COPY[errorCodeOf(err)] ?? READ_FALLBACK
}

function AccessNotice({ level, loading }: { level: AccessLevel; loading: boolean }) {
  // While the role is loading the page already fails closed: no control is shown.
  if (loading || level === 'owner_admin') return null
  if (level === 'member') {
    return (
      <Alert>
        <Lock className="size-4" aria-hidden />
        <AlertTitle>Read-only access</AlertTitle>
        <AlertDescription>
          Only an owner or admin can change the plan or cancel billing. Your role on this workspace is
          member, so the plan, usage and invoice history below are shown without controls.
        </AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="warning">
      <AlertCircle className="size-4" aria-hidden />
      <AlertTitle>Billing management is unavailable</AlertTitle>
      <AlertDescription>
        Your billing role could not be loaded from the server, so no plan change, portal or
        cancellation control is offered. Plan, usage and invoice history stay read-only.
      </AlertDescription>
    </Alert>
  )
}

function SectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  )
}

export default function BillingPage() {
  const utils = trpc.useUtils()

  const accessQuery = trpc.billing.access.useQuery()
  const subscriptionQuery = trpc.billing.subscription.useQuery()
  const usageQuery = trpc.billing.usage.useQuery()
  const plansQuery = trpc.billing.plans.useQuery()
  const invoicesQuery = trpc.billing.invoices.useQuery()

  const subscription = subscriptionQuery.data ?? null
  /**
   * Mutation controls require a current successful access read. A cached role
   * is not a current one: while the access query is loading, refetching, or
   * has just failed, the page fails closed and offers no control.
   */
  const roleConfirmed = accessQuery.isSuccess && !accessQuery.isRefetching
  const accessLevel = accessLevelFor(roleConfirmed ? ((accessQuery.data ?? null) as BillingRole | null) : null)
  const canManage = roleConfirmed && accessLevel === 'owner_admin'
  const level = subscriptionLevelFor(subscription)
  const statusCopy = SUBSCRIPTION_COPY[level]
  const actionable = subscriptionActionable(subscription)
  const scheduledCancel = hasScheduledCancellation(subscription)
  const rows = useMemo(() => usageRows(usageQuery.data ?? null), [usageQuery.data])
  const plans = plansQuery.data ?? []
  const invoices = invoicesQuery.data ?? []

  const portal = trpc.billing.portal.useMutation({
    onSuccess: (url) => {
      if (isSafeInvoiceUrl(url)) {
        window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      toast.error('Billing portal unavailable', {
        description: 'The billing service did not return a usable portal link. Nothing was opened.',
      })
    },
    onError: () => {
      toast.error('Billing portal unavailable', {
        description: 'The billing service could not open a portal session right now.',
      })
    },
  })

  const changePlan = trpc.billing.changePlan.useMutation({
    onSuccess: () => {
      void utils.billing.subscription.invalidate()
      void utils.billing.usage.invalidate()
      void utils.billing.invoices.invalidate()
    },
    onError: (err) => {
      // A failed mutation is never reported as a quiet "plan unchanged": a
      // timeout or lost response can follow a committed change, so affected
      // state is refetched and a definitive rejection is told apart from an
      // indeterminate result.
      void utils.billing.subscription.invalidate()
      void utils.billing.usage.invalidate()
      void utils.billing.invoices.invalidate()
      if (mutationOutcomeFor(errorCodeOf(err)) === 'rejected') {
        toast.error('Plan change was not applied', {
          description: 'The billing service rejected the change. Your current plan is unchanged.',
        })
      } else {
        toast.warning('Plan change result unknown', {
          description:
            'The billing service did not confirm the change before the request ended. The page is loading the latest state from the server - check the plan shown below.',
        })
      }
    },
  })

  const cancelSubscription = trpc.billing.cancel.useMutation({
    onSuccess: () => {
      void utils.billing.subscription.invalidate()
      void utils.billing.usage.invalidate()
      void utils.billing.invoices.invalidate()
    },
    onError: (err) => {
      void utils.billing.subscription.invalidate()
      void utils.billing.usage.invalidate()
      void utils.billing.invoices.invalidate()
      if (mutationOutcomeFor(errorCodeOf(err)) === 'rejected') {
        toast.error('Cancellation was not scheduled', {
          description: 'The billing service rejected the cancellation. Your plan continues unchanged.',
        })
      } else {
        toast.warning('Cancellation result unknown', {
          description:
            'The billing service did not confirm the cancellation before the request ended. The page is loading the latest state from the server - check the plan shown below.',
        })
      }
    },
  })

  const currency = subscription?.currency ?? ''

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Billing</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your plan, usage against plan limits, invoices and cancellation
          </p>
        </div>
        {canManage && actionable && (
          <Button
            variant="outline"
            className="min-h-11 w-full gap-2 sm:w-auto"
            onClick={() => portal.mutate()}
            disabled={portal.isPending}
          >
            <CreditCard className="size-4" aria-hidden />
            {portal.isPending ? 'Opening portal…' : 'Manage billing in Stripe'}
            <ExternalLink className="size-4" aria-hidden />
          </Button>
        )}
      </div>

      <AccessNotice
        level={accessLevel}
        loading={accessQuery.isPending || accessQuery.isRefetching}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {subscriptionQuery.isLoading ? (
            <SectionSkeleton />
          ) : subscriptionQuery.isError ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-destructive">
                {readError(subscriptionQuery.error).title}
              </p>
              <p className="text-sm text-muted-foreground">
                {readError(subscriptionQuery.error).description}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => void subscriptionQuery.refetch()}
              >
                <RefreshCw className="size-3 mr-1" aria-hidden /> Retry
              </Button>
            </div>
          ) : !subscription ? (
            <EmptyState
              icon={CreditCard}
              title="No active plan on this account"
              description="The billing service has no subscription for the signed-in account. Nothing is being charged and no plan limits are in force."
              action={
                <p className="text-xs text-muted-foreground">
                  Plan, payment method and invoice history appear here once a subscription exists.
                </p>
              }
            />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xl font-semibold">
                  {plans.find((plan) => plan.id === subscription.planTier)?.name ?? subscription.planTier}
                </span>
                <Badge variant={statusCopy.tone}>
                  {level === 'unknown' ? subscription.status : statusCopy.label}
                </Badge>
              </div>
              {(level === 'active' ||
                level === 'trialing' ||
                level === 'scheduled_cancel' ||
                level === 'past_due') && (
                <p className="text-sm text-muted-foreground">
                  {formatPlanPrice(subscription.price, currency)}
                  {formatPeriod(subscription.billingPeriod)
                    ? ` ${formatPeriod(subscription.billingPeriod)}`
                    : ''}
                </p>
              )}
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">Next billing date</dt>
                  <dd className="text-sm font-medium">
                    {subscription.nextBillingDate ? formatDate(subscription.nextBillingDate) : 'Not scheduled'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Current period ends</dt>
                  <dd className="text-sm font-medium">{formatDate(subscription.currentPeriodEnd)}</dd>
                </div>
              </dl>
              {statusCopy.note && (
                <Alert variant={level === 'past_due' ? 'destructive' : 'default'}>
                  <AlertTriangle className="size-4" aria-hidden />
                  <AlertTitle>{statusCopy.label}</AlertTitle>
                  <AlertDescription>{statusCopy.note}</AlertDescription>
                </Alert>
              )}
              {scheduledCancel && level !== 'scheduled_cancel' && (
                <Alert variant="warning">
                  <AlertTriangle className="size-4" aria-hidden />
                  <AlertTitle>Cancellation scheduled</AlertTitle>
                  <AlertDescription>
                    Your plan is set to end at the close of the current billing period
                    {subscription.currentPeriodEnd ? ` (${formatDate(subscription.currentPeriodEnd)})` : ''}. Access
                    continues until then.
                  </AlertDescription>
                </Alert>
              )}
              {canManage && actionable && (
                <div className="flex flex-col gap-2 pt-1 sm:flex-row">
                  <PlanChangeDialog
                    plans={plans}
                    currentTier={subscription.planTier}
                    currency={currency}
                    period={subscription.billingPeriod}
                    loading={plansQuery.isLoading}
                    error={plansQuery.isError ? readError(plansQuery.error) : null}
                    pending={changePlan.isPending}
                    onConfirm={(planTier) =>
                      changePlan.mutate(
                        { planTier },
                        {
                          onSuccess: (updated) => {
                            toast.success('Plan changed', {
                              description: updated
                                ? `Your plan is now ${updated.planTier}. The billing service accepted the change.`
                                : 'The billing service accepted the change.',
                            })
                          },
                        }
                      )
                    }
                  />
                  {!scheduledCancel && (
                    <CancelSubscriptionDialog
                      periodEnd={subscription.currentPeriodEnd}
                      pending={cancelSubscription.isPending}
                      onConfirm={() =>
                        cancelSubscription.mutate(undefined, {
                          onSuccess: (updated) => {
                            toast.success('Cancellation scheduled', {
                              description: updated?.nextBillingDate
                                ? `Access continues until ${formatDate(updated.nextBillingDate)}. The billing service accepted the cancellation.`
                                : 'The billing service accepted the cancellation at period end.',
                            })
                          },
                        })
                      }
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Usage against plan limits</CardTitle>
        </CardHeader>
        <CardContent>
          {usageQuery.isLoading ? (
            <SectionSkeleton />
          ) : usageQuery.isError ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-destructive">
                {readError(usageQuery.error).title}
              </p>
              <p className="text-sm text-muted-foreground">{readError(usageQuery.error).description}</p>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => void usageQuery.refetch()}
              >
                <RefreshCw className="size-3 mr-1" aria-hidden /> Retry
              </Button>
            </div>
          ) : (
            <ul className="space-y-4">
              {rows.map((row) => (
                <li key={row.key} className="space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{row.label}</span>
                    {row.level === 'no_plan' ? (
                      <span className="text-sm text-muted-foreground">No plan limits in force</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {formatUsageValue(row.used, row.key)} of {formatUsageValue(row.limit, row.key)}
                        {' · '}
                        {formatUsageValue(row.remaining, row.key)} remaining
                      </span>
                    )}
                  </div>
                  {row.level !== 'no_plan' && (
                    <Progress
                      value={row.limit > 0 ? Math.min(100, (row.used / row.limit) * 100) : 100}
                      className="h-2"
                      aria-label={`${row.label}: ${formatUsageValue(row.used, row.key)} of ${formatUsageValue(row.limit, row.key)}`}
                    />
                  )}
                  {row.level === 'over' && (
                    <p className="flex items-center gap-1 text-sm font-medium text-destructive">
                      <AlertTriangle className="size-3.5" aria-hidden />
                      Over the plan limit
                    </p>
                  )}
                  {row.level === 'near' && (
                    <p className="flex items-center gap-1 text-sm text-warning">
                      <AlertTriangle className="size-3.5" aria-hidden />
                      Approaching the plan limit
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {invoicesQuery.isLoading ? (
            <SectionSkeleton rows={4} />
          ) : invoicesQuery.isError ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-destructive">
                {readError(invoicesQuery.error).title}
              </p>
              <p className="text-sm text-muted-foreground">
                {readError(invoicesQuery.error).description}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => void invoicesQuery.refetch()}
              >
                <RefreshCw className="size-3 mr-1" aria-hidden /> Retry
              </Button>
            </div>
          ) : invoices.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No invoices yet"
              description="The billing service has no invoice history for this account."
            />
          ) : (
            <div className="-mx-2 overflow-x-auto px-2">
              <table className="w-full min-w-[22rem] border-collapse text-sm">
                <caption className="sr-only">Invoice history for the signed-in account</caption>
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">Date</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                    <th scope="col" className="py-2 pr-3 font-medium text-right">Amount</th>
                    <th scope="col" className="py-2 font-medium text-right">Receipt</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((invoice, index) => (
                    <tr key={`${invoice.created}-${index}`} className="border-b last:border-0">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatInvoiceDate(invoice.created)}</td>
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-1">
                          {invoice.status === 'paid' ? (
                            <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                          ) : (
                            <AlertCircle className="size-3.5 text-warning" aria-hidden />
                          )}
                          {invoice.status}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right whitespace-nowrap">
                        {formatInvoiceAmount(invoice.amountDue, invoice.currency)}
                      </td>
                      <td className="py-2 text-right">
                        {hasRenderableInvoiceLink(invoice) ? (
                          <span className="inline-flex flex-wrap justify-end gap-2">
                            {isSafeInvoiceUrl(invoice.invoiceUrl) && (
                              <a
                                href={invoice.invoiceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-h-11 items-center text-sm underline underline-offset-2"
                              >
                                View
                              </a>
                            )}
                            {isSafeInvoiceUrl(invoice.pdfUrl) && (
                              <a
                                href={invoice.pdfUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex min-h-11 items-center text-sm underline underline-offset-2"
                              >
                                PDF
                              </a>
                            )}
                          </span>
                        ) : (
                          <span className="text-sm text-muted-foreground">Not available</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
