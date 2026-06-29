'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Calendar, Clock, Monitor, CheckCircle, ArrowRight } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function WebinarPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!email) return
    setLoading(true)
    // Simulate registration — in production this would call an API
    await new Promise((r) => setTimeout(r, 1000))
    setSubmitted(true)
    setLoading(false)
  }

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
            <Link href="/webinar" className="text-sm font-medium text-foreground">Webinar</Link>
            <Link href="/sign-in" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">Sign in</Link>
          </nav>
        </div>
      </header>

      {/* Hero + Form */}
      <section className="relative overflow-hidden flex-1">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-background to-primary/5" />
        <div className="container mx-auto px-4 py-16 md:py-24 relative">
          <div className="grid md:grid-cols-2 gap-12 items-center max-w-5xl mx-auto">
            {/* Left: Copy */}
            <div>
              <div className="inline-flex items-center gap-2 text-sm text-primary font-medium mb-4 bg-primary/10 px-3 py-1 rounded-full">
                <Calendar className="h-4 w-4" />
                Free Live Webinar
              </div>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tight mb-6">
                Most AI app failures are invisible.
                <br />
                <span className="text-primary">Here&apos;s how to catch yours.</span>
              </h1>
              <p className="text-lg text-muted-foreground mb-8">
                In 45 minutes, learn the 5 silent killers of AI apps and how to stop them — no code required.
              </p>
              <ul className="space-y-4 mb-8">
                {[
                  'Why your app could be broken right now (and you\'d never know)',
                  'The 12-minute fix that saved a founder 15+ hours of debugging',
                  'A live demo: watch us catch and fix a real failure',
                  'Your 30-day plan to bulletproof your AI app',
                  'Exclusive offer for attendees: free app health audit',
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3">
                    <CheckCircle className="h-5 w-5 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              <blockquote className="text-sm text-muted-foreground italic border-l-2 border-primary/30 pl-4">
                &ldquo;I didn&apos;t know my API key had expired until they showed me. 12 minutes later it was fixed.&rdquo;
                <footer className="mt-1 not-italic font-medium">— Beta customer</footer>
              </blockquote>
            </div>

            {/* Right: Registration Form */}
            <div>
              <Card className="w-full">
                <CardHeader>
                  <CardTitle className="text-xl">Save Your Spot</CardTitle>
                  <p className="text-sm text-muted-foreground">Free webinar. Replay sent to all registrants.</p>
                </CardHeader>
                <CardContent>
                  {submitted ? (
                    <div className="text-center py-8">
                      <div className="h-12 w-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                        <CheckCircle className="h-6 w-6 text-green-600 dark:text-green-400" />
                      </div>
                      <h3 className="text-lg font-semibold mb-2">You&apos;re registered!</h3>
                      <p className="text-muted-foreground text-sm">
                        Check your inbox for webinar details and calendar invite.
                      </p>
                    </div>
                  ) : (
                    <form onSubmit={handleSubmit} className="space-y-4">
                      <div>
                        <label htmlFor="email" className="text-sm font-medium mb-1 block">Email address</label>
                        <input
                          id="email"
                          type="email"
                          required
                          placeholder="you@company.com"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                          className="w-full px-3 py-2 border border-input rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      </div>
                      <Button type="submit" className="w-full" disabled={loading}>
                        {loading ? 'Registering...' : 'Save My Spot'}
                        {!loading && <ArrowRight className="ml-2 h-4 w-4" />}
                      </Button>
                      <p className="text-xs text-muted-foreground text-center">
                        No spam. Unsubscribe anytime.
                      </p>
                    </form>
                  )}
                </CardContent>
              </Card>

              <div className="flex items-center justify-center gap-6 mt-6 text-sm text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  <span>45 min</span>
                </div>
                <div className="flex items-center gap-1">
                  <Monitor className="h-4 w-4" />
                  <span>Live + Replay</span>
                </div>
              </div>
            </div>
          </div>
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
              <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
              <Link href="/sign-in" className="hover:text-foreground transition-colors">Sign in</Link>
            </nav>
            <p className="text-sm text-muted-foreground">&copy; {new Date().getFullYear()} Nightlamp. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  )
}
