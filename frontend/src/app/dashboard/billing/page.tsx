'use client'

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { trpc } from '@/lib/trpc'

const plans = [
  { name: 'Watch', price: '$199', tier: 'watch', monitors: 10, features: ['10 monitors', 'Email alerts', '7-day history', 'Community support'] },
  { name: 'Respond', price: '$349', tier: 'respond', monitors: 25, features: ['25 monitors', 'Slack + Email alerts', '30-day history', 'Playbook access', 'Priority support'], popular: true },
  { name: 'White-Glove', price: '$499', tier: 'white_glove', monitors: -1, features: ['Unlimited monitors', 'All channels', '90-day history', 'Full playbook + remediation', 'Dedicated engineer', 'SLA guarantee'] },
]

const tierNames: Record<string, string> = { watch: 'Watch', respond: 'Respond', white_glove: 'White-Glove' }
const tierPrices: Record<string, string> = { watch: '$199', respond: '$349', white_glove: '$499' }

export default function BillingPage() {
  const email = 'test@nightlamp.dev'
  const { data: sub, isLoading: subLoading } = trpc.billing.subscription.useQuery({ email })
  const { data: usage } = trpc.billing.usage.useQuery({ email })

  const planTier = sub?.plan_tier ?? 'respond'
  const planName = tierNames[planTier] ?? 'Respond'
  const planPrice = tierPrices[planTier] ?? '$349'
  const monitorsUsed = usage?.monitors_used ?? 0
  const currentPlan = plans.find((p) => p.tier === planTier) ?? plans[1]
  const monitorLimit = currentPlan.monitors
  const monitorPct = monitorLimit > 0 ? Math.round((monitorsUsed / monitorLimit) * 100) : 100
  const reportsGenerated = usage?.reports_generated ?? 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your subscription and billing</p>
      </div>

      {subLoading ? (
        <p className="text-sm text-muted-foreground">Loading subscription...</p>
      ) : (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Current Plan</CardTitle>
                <CardDescription>{planName} - {planPrice}/month</CardDescription>
              </div>
              <Badge className={sub?.status === 'active' ? 'bg-success' : ''}>
                {sub?.status ?? 'active'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Monitors used</span>
                <span className="font-mono">{monitorsUsed}{monitorLimit > 0 ? ` / ${monitorLimit}` : ''}</span>
              </div>
              <Progress value={Math.min(monitorPct, 100)} className="h-2" />
            </div>
            <div className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Reports generated</span>
                <span className="font-mono">{reportsGenerated} / ∞</span>
              </div>
              <Progress value={100} className="h-2 [&>div]:bg-success" />
            </div>
            <div className="pt-2 flex gap-3">
              <Button variant="outline" size="sm">Change Plan</Button>
              <Button variant="outline" size="sm">Billing Portal</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <h2 className="text-lg font-semibold mt-8">Available Plans</h2>
      <div className="grid grid-cols-3 gap-4">
        {plans.map((plan) => (
          <Card key={plan.tier} className={plan.tier === planTier ? 'border-primary' : plan.popular ? 'border-primary' : ''}>
            <CardHeader>
              {plan.tier === planTier && (
                <Badge className="w-fit mb-2 bg-primary">Current Plan</Badge>
              )}
              {plan.popular && plan.tier !== planTier && (
                <Badge className="w-fit mb-2 bg-primary">Most Popular</Badge>
              )}
              <CardTitle>{plan.name}</CardTitle>
              <CardDescription>
                <span className="text-2xl font-bold text-foreground">{plan.price}</span>
                <span className="text-muted-foreground">/month</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <ul className="space-y-2">
                {plan.features.map((f) => (
                  <li key={f} className="text-sm text-muted-foreground flex items-center gap-2">
                    <span className="size-1.5 rounded-full bg-primary shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Button className="w-full" variant={plan.tier === planTier ? 'default' : 'outline'} disabled={plan.tier === planTier}>
                {plan.tier === planTier ? 'Current Plan' : 'Upgrade'}
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Payment Method</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <div className="size-10 rounded bg-muted flex items-center justify-center text-sm font-mono">••••</div>
            <div>
              <p className="text-sm font-medium">Visa ending in 4242</p>
              <p className="text-xs text-muted-foreground">Expires 12/2027</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
