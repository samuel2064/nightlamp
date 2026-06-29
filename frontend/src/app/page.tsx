'use client'

import Link from 'next/link'
import { ArrowRight, CheckCircle, Shield, Activity, AlertTriangle, Database, Webhook, TrendingUp, Plug, Search, Wrench } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const failures = [
  { icon: AlertTriangle, name: 'Expired API keys', problem: '401 errors. Feature stops working.', solution: 'Detects + fixes in 12 min' },
  { icon: Activity, name: 'Rate limit shifts', problem: '429 errors. Degraded UX.', solution: 'Alerts before users notice' },
  { icon: Database, name: 'Schema drift', problem: 'Data pipeline breaks silently', solution: 'Detects mismatch in real-time' },
  { icon: Webhook, name: 'Broken webhooks', problem: 'Data loss. No one checks.', solution: 'Verifies endpoints daily' },
  { icon: TrendingUp, name: 'Error spikes', problem: 'Slower app. Churn grows.', solution: 'Alerts + playbook match' },
]

const tiers = [
  {
    name: 'Indie',
    price: '$99',
    tagline: 'For solo founders who ship fast.',
    features: ['10 app monitors', '5 active playbooks', 'Email + Slack alerts', '30-min detection SLA', '14-day free trial'],
    cta: 'Start Free Trial',
    popular: false,
  },
  {
    name: 'Growth',
    price: '$299',
    tagline: 'For teams that need sleep.',
    features: ['30 app monitors', '25 active playbooks', 'All channels (Slack, SMS, PagerDuty)', 'Auto-fix enabled', '5-min detection SLA', 'Monthly health audit', '14-day free trial'],
    cta: 'Start Free Trial',
    popular: true,
  },
  {
    name: 'Scale',
    price: '$499',
    tagline: 'For companies that cannot fail.',
    features: ['Unlimited monitors', 'Unlimited playbooks', 'White-label available', 'Full automation', '30-min priority support', 'Weekly health audit', 'Custom playbook dev', '14-day free trial'],
    cta: 'Talk to Sales',
    popular: false,
  },
]

export default function LandingPage() {
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
            <Link href="/pricing" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Pricing</Link>
            <Link href="/webinar" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Webinar</Link>
            <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Sign in</Link>
            <Link href="/sign-up" className={cn(buttonVariants())}>Start Free Trial</Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/5" />
        <div className="container mx-auto px-4 py-24 md:py-32 relative">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
              Your AI app is broken right now.{' '}
              <span className="text-primary">We&apos;ll prove it.</span>
            </h1>
            <p className="text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
              Nightlamp monitors your app 24/7, catches silent failures before users do, and fixes them without you touching code.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link href="/sign-up" className={cn(buttonVariants({ size: 'lg' }))}>
                Get Your Free App Health Audit
                <ArrowRight className="ml-2 h-5 w-5" />
              </Link>
              <Link href="/webinar" className={cn(buttonVariants({ size: 'lg', variant: 'outline' }))}>Watch the Webinar</Link>
            </div>
            <blockquote className="mt-12 text-sm text-muted-foreground italic border-l-2 border-primary/30 pl-4 text-left max-w-lg mx-auto">
              &ldquo;Found 3 expired API keys we didn&apos;t know about in the first 5 minutes.&rdquo;
              <footer className="mt-1 not-italic font-medium">— Beta user</footer>
            </blockquote>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="border-t py-20">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">How It Works</h2>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {[
              { step: '1', icon: Plug, title: 'Connect', time: '2 min', desc: 'Link your app. We scan every API key, webhook, and integration.' },
              { step: '2', icon: Activity, title: 'We find what\'s broken', time: '90 seconds', desc: 'Our engine detects expired keys, broken webhooks, rate limit shifts, and schema drift.' },
              { step: '3', icon: Shield, title: 'We fix it', time: 'or tell you how', desc: 'Auto-fix for 80% of failures. For the rest, step-by-step playbooks.' },
            ].map((item) => (
              <Card key={item.step} className="relative">
                <CardHeader>
                  <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-2">
                    <item.icon className="h-6 w-6 text-primary" />
                  </div>
                  <CardTitle>
                    <span className="text-primary font-mono text-sm">0{item.step}</span>
                    <br />
                    {item.title}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">{item.time}</p>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">{item.desc}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* The Silent 5 */}
      <section className="border-t py-20 bg-muted/30">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-4">The Silent 5</h2>
          <p className="text-lg text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Five failures that are invisible to standard monitoring — and how Nightlamp catches them.
          </p>
          <div className="max-w-4xl mx-auto overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b">
                  <th className="py-4 px-4 font-semibold">Failure</th>
                  <th className="py-4 px-4 font-semibold">What Happens</th>
                  <th className="py-4 px-4 font-semibold">Nightlamp</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={f.name} className="border-b last:border-0">
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-2">
                        <f.icon className="h-4 w-4 text-destructive" />
                        <span className="font-medium">{f.name}</span>
                      </div>
                    </td>
                    <td className="py-4 px-4 text-muted-foreground">{f.problem}</td>
                    <td className="py-4 px-4">
                      <div className="flex items-center gap-1 text-green-600 dark:text-green-400">
                        <CheckCircle className="h-4 w-4" />
                        <span>{f.solution}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Pricing Preview */}
      <section className="border-t py-20">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-4">Simple, Transparent Pricing</h2>
          <p className="text-lg text-muted-foreground text-center mb-12 max-w-2xl mx-auto">
            Start free. Upgrade when you need more.
          </p>
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {tiers.map((tier) => (
              <Card key={tier.name} className={`relative flex flex-col ${tier.popular ? 'border-primary shadow-lg ring-1 ring-primary' : ''}`}>
                {tier.popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs font-semibold px-4 py-1 rounded-full">
                    Most Popular
                  </div>
                )}
                <CardHeader>
                  <CardTitle>{tier.name}</CardTitle>
                  <div className="mt-2">
                    <span className="text-4xl font-bold">{tier.price}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{tier.tagline}</p>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col">
                  <ul className="space-y-3 mb-8 flex-1">
                    {tier.features.map((f) => (
                      <li key={f} className="flex items-start gap-2 text-sm">
                        <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link href="/sign-up" className={cn(buttonVariants({ variant: tier.popular ? 'default' : 'outline' }), 'w-full block text-center')}>{tier.cta}</Link>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="text-center text-sm text-muted-foreground mt-6">
            All plans include a 14-day free trial. No credit card required for Indie.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t py-20 bg-primary text-primary-foreground">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold mb-4">Ready to stop silent failures?</h2>
          <p className="text-lg text-primary-foreground/80 mb-8 max-w-xl mx-auto">
            Join hundreds of founders who sleep better knowing Nightlamp has their back.
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
              <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
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
