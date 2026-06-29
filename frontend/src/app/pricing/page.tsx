'use client'

import Link from 'next/link'
import { CheckCircle, ArrowRight, HelpCircle } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const tiers = [
  {
    name: 'Indie',
    price: '$99',
    tagline: 'Ship without the fear',
    description: 'For solo founders who ship fast.',
    features: [
      { included: true, label: '10 app monitors' },
      { included: true, label: '< 30 min detection SLA' },
      { included: true, label: '5 active playbooks' },
      { included: true, label: 'Email + Slack alerts' },
      { included: true, label: 'Auto-fix (manual approval)' },
      { included: true, label: 'One-time app health audit' },
      { included: false, label: 'SMS & PagerDuty alerts' },
      { included: false, label: 'Playbook analytics' },
      { included: false, label: 'White-label mode' },
    ],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Growth',
    price: '$299',
    tagline: 'Your app got traction. Your monitoring should too.',
    description: 'For teams that need sleep.',
    features: [
      { included: true, label: '30 app monitors' },
      { included: true, label: '< 5 min detection SLA' },
      { included: true, label: '25 active playbooks' },
      { included: true, label: 'Email + Slack alerts' },
      { included: true, label: 'Auto-fix (automated)' },
      { included: true, label: 'Monthly health audit' },
      { included: true, label: 'SMS & PagerDuty alerts' },
      { included: true, label: 'Playbook analytics' },
      { included: true, label: 'Priority support (2h)' },
      { included: false, label: 'White-label mode' },
    ],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Scale',
    price: '$499',
    tagline: 'Enterprise reliability without the enterprise headache',
    description: 'For companies that cannot fail.',
    features: [
      { included: true, label: 'Unlimited monitors' },
      { included: true, label: '< 1 min detection SLA' },
      { included: true, label: 'Unlimited playbooks' },
      { included: true, label: 'All channels + custom webhook' },
      { included: true, label: 'Full automation' },
      { included: true, label: 'Weekly health audit' },
      { included: true, label: 'SMS & PagerDuty alerts' },
      { included: true, label: 'Full analytics & reports' },
      { included: true, label: 'White-label mode' },
      { included: true, label: 'Custom playbook dev' },
      { included: true, label: '30-min support, 24/7' },
    ],
    cta: 'Talk to Sales',
    popular: false,
  },
]

const faqs = [
  { q: 'How is this different from Sentry/Datadog?', a: 'Sentry gives you error logs. Datadog gives you dashboards. Nightlamp gives you a fix. We\'re not a monitoring tool — we\'re an automated mechanic.' },
  { q: 'Do I need to know how to code?', a: 'No. Nightlamp was built for AI and no-code app builders. If you can connect an API, you can use Nightlamp.' },
  { q: 'What apps does it work with?', a: 'Any app that uses external APIs, webhooks, or integrations. Cursor, Bolt, Bubble, Webflow, FlutterFlow — if it has dependencies, we cover it.' },
  { q: 'Can I try before I buy?', a: 'Yes. 14-day free trial on all plans. No credit card required for Indie tier.' },
  { q: 'What if I just want to monitor one app?', a: 'Indie tier is perfect. 10 monitors cover auth, billing, core flows, and integrations.' },
  { q: 'Can I cancel anytime?', a: 'Yes. No contracts. No lock-in.' },
  { q: 'Is there an annual discount?', a: 'Yes. Save 20% with annual billing on any plan.' },
]

export default function PricingPage() {
  return (
    <div className="flex flex-col min-h-screen">
      {/* Navigation */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container mx-auto flex h-16 items-center justify-between px-4">
          <Link href="/" className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">N</span>
            </div>
            <span className="font-bold text-xl">Nightlamp</span>
          </Link>
          <nav className="hidden md:flex items-center gap-6">
            <Link href="/pricing" className="text-sm font-medium text-foreground">Pricing</Link>
            <Link href="/webinar" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Webinar</Link>
            <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Sign in</Link>
            <Link href="/sign-up" className={cn(buttonVariants())}>Start Free Trial</Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="py-20 md:py-28">
        <div className="container mx-auto px-4 text-center">
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-6 max-w-3xl mx-auto">
            The price of a single unnoticed failure is higher than any plan.
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Nightlamp starts at $99/mo. The average customer finds and fixes $3,000+ in hidden issues in their first month.
          </p>
        </div>
      </section>

      {/* Tier Cards */}
      <section className="pb-20">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            {tiers.map((tier) => (
              <Card key={tier.name} className={`relative flex flex-col ${tier.popular ? 'border-primary shadow-lg ring-1 ring-primary scale-105 md:scale-110' : ''}`}>
                {tier.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-semibold px-4 py-1 rounded-full">
                    Most Popular
                  </div>
                )}
                <CardHeader>
                  <CardTitle className="text-lg">{tier.name}</CardTitle>
                  <div className="mt-2">
                    <span className="text-4xl font-bold">{tier.price}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{tier.tagline}</p>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col">
                  <ul className="space-y-2.5 mb-8 flex-1">
                    {tier.features.map((f) => (
                      <li key={f.label} className={`flex items-start gap-2 text-sm ${f.included ? '' : 'text-muted-foreground/50'}`}>
                        <CheckCircle className={`h-4 w-4 mt-0.5 shrink-0 ${f.included ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground/30'}`} />
                        <span className={f.included ? '' : 'line-through'}>{f.label}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href={tier.name === 'Scale' ? '/webinar' : '/sign-up'} className={cn(buttonVariants({ variant: tier.popular ? 'default' : 'outline' }), 'w-full block text-center')}>
                    {tier.cta}
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="border-t py-16 bg-muted/30">
        <div className="container mx-auto px-4 max-w-4xl">
          <div className="grid md:grid-cols-2 gap-8">
            <blockquote className="border-l-2 border-primary/30 pl-4">
              <p className="text-muted-foreground italic">&ldquo;Nightlamp caught an expired API token within seconds. Fixed in 12 minutes. Zero customer impact.&rdquo;</p>
              <footer className="mt-2 font-medium text-sm">— Founder, AI Support Co.</footer>
            </blockquote>
            <blockquote className="border-l-2 border-primary/30 pl-4">
              <p className="text-muted-foreground italic">&ldquo;We run 15 no-code apps for clients. Nightlamp is our insurance policy.&rdquo;</p>
              <footer className="mt-2 font-medium text-sm">— Agency Partner</footer>
            </blockquote>
          </div>
        </div>
      </section>

      {/* Comparison Table */}
      <section className="border-t py-20">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">Compare Plans</h2>
          <div className="max-w-5xl mx-auto overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-4 pr-8 font-semibold">Feature</th>
                  <th className="py-4 px-4 font-semibold text-center">Indie</th>
                  <th className="py-4 px-4 font-semibold text-center text-primary">Growth</th>
                  <th className="py-4 px-4 font-semibold text-center">Scale</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b">
                  <td className="py-3 pr-8 text-muted-foreground">Price</td>
                  <td className="py-3 px-4 text-center font-medium">$99/mo</td>
                  <td className="py-3 px-4 text-center font-medium text-primary">$299/mo</td>
                  <td className="py-3 px-4 text-center font-medium">$499/mo</td>
                </tr>
                {[
                  { label: 'Detection speed', indie: 'Within 30 min', growth: 'Within 5 min', scale: 'Within 1 min' },
                  { label: 'Auto-fix', indie: 'Manual', growth: 'Automated', scale: 'Fully autonomous' },
                  { label: 'Playbooks', indie: '5', growth: '25', scale: 'Unlimited' },
                  { label: 'White-label', indie: '\u2014', growth: '\u2014', scale: '\u2713' },
                  { label: 'Monitors', indie: '10', growth: '30', scale: 'Unlimited' },
                  { label: 'Support', indie: 'Email', growth: 'Priority (2h)', scale: '24/7 (30 min)' },
                ].map((row) => (
                  <tr key={row.label} className="border-b last:border-0">
                    <td className="py-3 pr-8 text-muted-foreground">{row.label}</td>
                    <td className="py-3 px-4 text-center">{row.indie}</td>
                    <td className="py-3 px-4 text-center">{row.growth}</td>
                    <td className="py-3 px-4 text-center">{row.scale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t py-20 bg-muted/30">
        <div className="container mx-auto px-4 max-w-3xl">
          <h2 className="text-3xl font-bold text-center mb-12">Frequently Asked Questions</h2>
          <div className="space-y-6">
            {faqs.map((faq) => (
              <details key={faq.q} className="group">
                <summary className="flex items-center justify-between cursor-pointer py-3 border-b group-open:border-primary/30">
                  <span className="font-medium">{faq.q}</span>
                  <HelpCircle className="h-4 w-4 text-muted-foreground group-open:rotate-180 transition-transform" />
                </summary>
                <p className="py-4 text-muted-foreground">{faq.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-primary text-primary-foreground">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Start your free trial today</h2>
          <p className="text-lg text-primary-foreground/80 mb-8 max-w-xl mx-auto">
            No credit card required. Full access to all Indie features for 14 days.
          </p>
          <Link href="/sign-up" className={cn(buttonVariants({ size: 'lg', variant: 'secondary' }))}>
            Get Your Free App Health Audit
            <ArrowRight className="ml-2 h-5 w-5" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-12">
        <div className="container mx-auto px-4">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center">
                <span className="text-primary-foreground font-bold text-xs">N</span>
              </div>
              <span className="font-bold">Nightlamp</span>
            </div>
            <nav className="flex items-center gap-6 text-sm text-muted-foreground">
              <Link href="/" className="hover:text-foreground transition-colors">Home</Link>
              <Link href="/webinar" className="hover:text-foreground transition-colors">Webinar</Link>
              <Link href="/sign-in" className="hover:text-foreground transition-colors">Sign in</Link>
            </nav>
            <p className="text-sm text-muted-foreground">&copy; {new Date().getFullYear()} Nightlamp. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
