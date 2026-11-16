'use client'

import { useState } from 'react'
import { trpc } from '@/lib/trpc'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { RefreshCw, CreditCard, ExternalLink, AlertCircle } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'

// TODO: Backend billing portal endpoint (/api/billing/portal) not yet implemented.
// Requires Stripe customer portal integration on the backend.
// When available, the portal mutation will return a Stripe customer portal URL.

export default function BillingPage() {
  const { data, isLoading, isError, refetch } = trpc.billing.summary.useQuery()
  const openPortal = trpc.billing.portal.useMutation({
    onSuccess: (data) => {
      if (data?.url) {
        window.open(data.url, '_blank')
      } else {
        toast.error('Billing portal not configured', { description: 'Please contact support to set up billing portal access.' })
      }
    },
    onError: (err) => {
      toast.error('Billing portal unavailable', { description: 'Stripe customer portal integration is not yet configured on the backend.' })
    },
  })

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-4 w-52" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-9 w-12" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <div className="flex items-center gap-2">
          <p className="text-sm text-destructive">Failed to load billing data.</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="size-3 mr-1" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Subscription and billing overview
        </p>
        <EmptyState
          icon={RefreshCw}
          title="No billing data"
          description="Subscription and billing data will appear here once your app sends its first billing event."
        />
      </div>
    )
  }

  const stats = [
    { label: 'Customers', value: data?.customers ?? 0 },
    { label: 'Subscriptions', value: data?.subscriptions ?? 0 },
    { label: 'Active', value: data?.activeSubscriptions ?? 0 },
    { label: 'Past Due', value: data?.pastDue ?? 0 },
    { label: 'Canceled', value: data?.canceled ?? 0 },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Billing</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Subscription and billing overview
          </p>
        </div>
        <Button
          onClick={() => openPortal.mutate()}
          disabled={openPortal.isPending}
          className="gap-2"
        >
          <CreditCard className="size-4" />
          <ExternalLink className="size-4" />
          Manage Billing
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{s.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => openPortal.mutate()}
            disabled={openPortal.isPending}
            className="w-full"
          >
            {openPortal.isPending ? (
              <>
                <span className="animate-spin">⟳</span> Opening portal...
              </>
            ) : (
              <>
                <CreditCard className="size-4 mr-2" />
                Open Customer Portal
              </>
            )}
          </Button>
          <div className="mt-3 flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              <AlertCircle className="size-2.5 mr-1" aria-hidden />
              Portal requires Stripe setup
            </Badge>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Manage your subscription, update payment method, and view invoices.
            Stripe customer portal integration is pending backend configuration.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
