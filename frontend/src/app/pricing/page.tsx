'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, ArrowRight, HelpCircle } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

type Tier = {
  name: string
  tagline: string
  description: string
  features: string[]
  cta: string
  href: string
  popular?: boolean
  price: { monthly: number | null; annual: number | null }
}

const tiers: Tier[] = [
  {
    name: 'Free',
    price: { monthly: 0, annual: null },
    tagline: 'Catch the obvious break.',
    description: 'For founders who want one app watched before paying anything.',
    features: [
      '1 app monitored',
      '100 checks/day',
      'Basic action + uptime checks',
      'Email alerts',
      'Community support',
    ],
    cta: 'Start for free',
    href: '/sign-up',
  },
  {
    name: 'Pro',
    price: { monthly: 99, annual: 999 },
    tagline: 'Ship without the fear.',
    description: 'For solo founders with one product and real users.',
    features: [
      '5 apps',
      '10,000 checks/day',
      'Checks for auth, billing, and core actions',
      'Webhook and API-key validation',
      'Email + Slack alerts',
      'Playbooks for known failures',
      'Priority email support',
    ],
    cta: 'Start 30-day beta',
    href: '/sign-up',
    popular: true,
  },
  {
    name: 'Team',
    price: { monthly: 299, annual: 2990 },
    tagline: 'Your app got traction. Your monitoring should too.',
    description: 'For small teams and agencies running several apps.',
    features: [
      'Everything in Pro',
      '20 apps',
      'Unlimited checks',
      '5 team seats',
      'Custom playbooks',
      'Priority support, 2-hour response target',
    ],
    cta: 'Start 30-day beta',
    href: '/sign-up',
  },
  {
    name: 'Enterprise',
    price: { monthly: null, annual: null },
    tagline: 'Run monitoring under your own brand.',
    description: 'For accelerators, agencies, and companies with an SLA.',
    features: [
      'Unlimited apps',
      'Custom SLA',
      'Dedicated engineer',
      'White-label reports and alerts',
      'Custom playbook development',
      'Invoicing',
    ],
    cta: 'Contact sales',
    href: '/sign-up?plan=enterprise',
  },
]

const comparisonRows = [
  { label: 'Apps', free: '1', pro: '5', team: '20', enterprise: 'Unlimited' },
  { label: 'Checks/day', free: '100', pro: '10,000', team: 'Unlimited', enterprise: 'Unlimited' },
  { label: 'Alerts', free: 'Email', pro: 'Email + Slack', team: 'Email + Slack', enterprise: 'Email + Slack + custom webhook' },
  { label: 'Playbooks', free: '—', pro: 'Standard', team: 'Custom', enterprise: 'Custom development' },
  { label: 'Team seats', free: '1', pro: '1', team: '5', enterprise: 'Unlimited' },
  { label: 'Support', free: 'Community', pro: 'Priority email', team: 'Priority, 2h target', enterprise: 'Dedicated engineer' },
  { label: 'White-label', free: '—', pro: '—', team: '—', enterprise: 'Yes' },
  { label: 'Annual', free: '—', pro: '$999/yr', team: '$2,990/yr', enterprise: 'Custom' },
]

const faqs = [
  {
    q: 'Is there really a free plan?',
    a: 'Yes — one app, 100 checks a day, email alerts. No card, no expiry date.',
  },
  {
    q: 'What happens after 30 days of beta?',
    a: 'You choose a plan or you stop. No auto-charge, no card on file.',
  },
  {
    q: 'How is this different from Sentry or UptimeRobot?',
    a: 'They report that a page is down or an exception fired. Nightlamp checks whether the actions still work — signup, checkout, webhooks — and tells you what broke.',
  },
  {
    q: 'Do I need to know how to code?',
    a: 'No. If you can paste a URL and create a test account, we can monitor the app.',
  },
  {
    q: 'Do you offer annual billing?',
    a: 'Yes — $999/yr for Pro and $2,990/yr for Team. That saves $189/yr and $598/yr versus monthly, up to 17%.',
  },
  {
    q: 'What does white-label include?',
    a: 'Reports and alerts under your brand, one invoice, and a named engineer. Dashboard-level multi-tenancy is not available yet — tell us what you need and we will scope it.',
  },
]

function annualEquivalent(annual: number) {
  return Math.round(annual / 12)
}

export default function PricingPage() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly')
  const annual = billingCycle === 'annual'

  return (
    <div className="flex min-h-screen flex-col">
      {/* Navigation */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary">
              <span className="text-sm font-bold text-primary-foreground">N</span>
            </div>
            <span className="text-xl font-bold">Nightlamp</span>
          </Link>
          <nav className="hidden items-center gap-6 md:flex">
            <Link href="/pricing" className="text-sm font-medium text-foreground">
              Pricing
            </Link>
            <Link href="/webinar" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Webinar
            </Link>
            <Link href="/sign-in" className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
              Sign in
            </Link>
            <Link href="/sign-up" className={cn(buttonVariants())}>
              Start free
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="py-16 md:py-24">
        <div className="container mx-auto px-4 text-center">
          <p className="mb-4 text-sm font-medium uppercase tracking-wider text-primary">
            Simple, transparent pricing
          </p>
          <h1 className="mx-auto mb-6 max-w-3xl text-4xl font-bold tracking-tight md:text-5xl">
            The price of a single unnoticed failure is higher than any plan.
          </h1>
          <p className="mx-auto max-w-2xl text-lg text-muted-foreground md:text-xl">
            Start free. Pro is $99/mo, Team $299/mo, and Enterprise is custom. Every plan checks
            the actions that uptime tools never see.
          </p>
        </div>
      </section>

      {/* Beta banner + billing toggle */}
      <section className="pb-8">
        <div className="container mx-auto max-w-3xl px-4">
          <div className="mb-8 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-center text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Beta:</span> 30 days free on Pro and
            Team. No card, no auto-charge.
          </div>
          <div className="flex items-center justify-center gap-4 sm:gap-6">
            <span
              className={cn(
                'text-sm font-medium transition-colors',
                !annual ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              Monthly
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={annual}
              aria-label="Toggle annual billing"
              onClick={() => setBillingCycle(annual ? 'monthly' : 'annual')}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                annual ? 'bg-primary' : 'bg-input'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none block h-5 w-5 rounded-full bg-background shadow-lg ring-0 transition-transform',
                  annual ? 'translate-x-5' : 'translate-x-0'
                )}
              />
            </button>
            <span
              className={cn(
                'flex items-center gap-2 text-sm font-medium transition-colors',
                annual ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              Annual
              <Badge variant="secondary" className="text-xs">
                Save up to 17%
              </Badge>
            </span>
          </div>
        </div>
      </section>

      {/* Tier Cards */}
      <section className="pb-20">
        <div className="container mx-auto px-4">
          <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-4">
            {tiers.map((tier) => {
              const showAnnual = annual && tier.price.annual !== null
              return (
                <Card
                  key={tier.name}
                  className={cn(
                    'relative flex flex-col',
                    tier.popular && 'border-primary shadow-lg ring-1 ring-primary'
                  )}
                >
                  {tier.popular && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-4 py-1 text-xs font-semibold text-primary-foreground">
                      Most popular
                    </div>
                  )}
                  <CardHeader>
                    <CardTitle className="text-lg">{tier.name}</CardTitle>
                    <div className="mt-2 flex min-h-[3.5rem] flex-col justify-end">
                      {tier.price.monthly === null ? (
                        <span className="text-4xl font-bold">Custom</span>
                      ) : showAnnual && tier.price.annual !== null ? (
                        <>
                          <div className="flex items-baseline gap-1">
                            <span className="text-4xl font-bold">
                              ${tier.price.annual.toLocaleString('en-US')}
                            </span>
                            <span className="text-muted-foreground">/yr</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            ${annualEquivalent(tier.price.annual)}/mo · save $
                            {(tier.price.monthly! * 12 - tier.price.annual).toLocaleString('en-US')}/yr
                          </span>
                        </>
                      ) : (
                        <div className="flex items-baseline gap-1">
                          <span className="text-4xl font-bold">${tier.price.monthly}</span>
                          <span className="text-muted-foreground">/mo</span>
                        </div>
                      )}
                    </div>
                    <p className="mt-2 text-sm font-medium text-foreground">{tier.tagline}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{tier.description}</p>
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col">
                    <ul className="mb-8 flex-1 space-y-2.5">
                      {tier.features.map((feature) => (
                        <li key={feature} className="flex items-start gap-2 text-sm">
                          <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                          <span>{feature}</span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={tier.href}
                      className={cn(
                        buttonVariants({ variant: tier.popular ? 'default' : 'outline' }),
                        'block w-full text-center'
                      )}
                    >
                      {tier.cta}
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </div>
      </section>

      {/* Comparison Table */}
      <section className="border-t py-20">
        <div className="container mx-auto px-4">
          <h2 className="mb-12 text-center text-3xl font-bold">Compare plans</h2>
          <div className="mx-auto max-w-5xl overflow-x-auto">
            <table className="w-full min-w-[640px] text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-4 pr-6 font-semibold">Feature</th>
                  <th className="px-3 py-4 text-center font-semibold">Free</th>
                  <th className="px-3 py-4 text-center font-semibold text-primary">Pro</th>
                  <th className="px-3 py-4 text-center font-semibold">Team</th>
                  <th className="px-3 py-4 text-center font-semibold">Enterprise</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.label} className="border-b last:border-0">
                    <td className="py-3 pr-6 text-muted-foreground">{row.label}</td>
                    <td className="px-3 py-3 text-center">{row.free}</td>
                    <td className="px-3 py-3 text-center">{row.pro}</td>
                    <td className="px-3 py-3 text-center">{row.team}</td>
                    <td className="px-3 py-3 text-center">{row.enterprise}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="border-t py-16">
        <div className="container mx-auto max-w-3xl px-4">
          <div className="space-y-4 text-center text-muted-foreground">
            <p>
              We run Nightlamp on our own app. In October our production build was 11 weeks stale
              and uptime monitoring never flagged it. We found it by testing our own signup form.
            </p>
            <p className="font-medium text-foreground">
              Every claim on this page is something we can show you. If we cannot, we remove it.
            </p>
          </div>
        </div>
      </section>

      {/* Beta CTA */}
      <section className="border-t bg-muted/30 py-16">
        <div className="container mx-auto max-w-4xl px-4 text-center">
          <p className="text-lg text-muted-foreground">
            Beta founders get 30 days of monitoring and a full app health report. No card.
          </p>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t py-20">
        <div className="container mx-auto max-w-3xl px-4">
          <h2 className="mb-12 text-center text-3xl font-bold">Frequently asked questions</h2>
          <div className="space-y-6">
            {faqs.map((faq) => (
              <details key={faq.q} className="group">
                <summary className="flex cursor-pointer items-center justify-between border-b py-3 group-open:border-primary/30">
                  <span className="font-medium">{faq.q}</span>
                  <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                </summary>
                <p className="py-4 text-muted-foreground">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-primary py-20 text-primary-foreground">
        <div className="container mx-auto px-4 text-center">
          <h2 className="mb-4 text-3xl font-bold">Start free today</h2>
          <p className="mx-auto mb-8 max-w-xl text-lg text-primary-foreground/80">
            30 days free on Pro and Team. No card, no auto-charge.
          </p>
          <Link
            href="/sign-up"
            className={cn(buttonVariants({ size: 'lg', variant: 'secondary' }))}
          >
            Get your free app health audit
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-12">
        <div className="container mx-auto px-4">
          <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary">
                <span className="text-xs font-bold text-primary-foreground">N</span>
              </div>
              <span className="font-bold">Nightlamp</span>
            </div>
            <nav className="flex items-center gap-6 text-sm text-muted-foreground">
              <Link href="/" className="transition-colors hover:text-foreground">
                Home
              </Link>
              <Link href="/webinar" className="transition-colors hover:text-foreground">
                Webinar
              </Link>
              <Link href="/sign-in" className="transition-colors hover:text-foreground">
                Sign in
              </Link>
            </nav>
            <p className="text-sm text-muted-foreground">
              &copy; {new Date().getFullYear()} Nightlamp. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}
