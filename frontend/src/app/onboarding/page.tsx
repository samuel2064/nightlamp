'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useUser } from '@clerk/nextjs'
import { trpc } from '@/lib/trpc'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Check, ChevronRight, AlertCircle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
  { id: 'app-detection', label: 'App Detection', description: 'Tell us about your application' },
  { id: 'monitor-selection', label: 'Monitor Selection', description: 'Choose which monitors to connect' },
  { id: 'alert-config', label: 'Alert Configuration', description: 'Configure how you want to be notified' },
  { id: 'team-invite', label: 'Team Invites', description: 'Invite team members (optional)' },
] as const

type StepId = typeof STEPS[number]['id']

interface OnboardingSession {
  sessionId: string
  currentStep: StepId
  completed: boolean
  createdTeamId?: string
  stepData: Record<string, unknown>
}

export default function OnboardingPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, isLoaded } = useUser()
  const [session, setSession] = useState<OnboardingSession | null>(null)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const startMutation = trpc.onboarding.start.useMutation()
  const statusQuery = trpc.onboarding.status.useQuery(
    { sessionId: session?.sessionId ?? '' },
    { enabled: !!session?.sessionId }
  )
  const stepMutation = trpc.onboarding.step.useMutation()
  const completeMutation = trpc.onboarding.complete.useMutation()

  useEffect(() => {
    if (!isLoaded) return
    if (!user) {
      router.push('/sign-in')
      return
    }
    loadOrCreateSession()
  }, [isLoaded, user, router])

  const loadOrCreateSession = async () => {
    try {
      setLoading(true)
      const result = await startMutation.mutateAsync({ userId: user?.id ?? '' })
      setSession(result)
      const stepIndex = STEPS.findIndex(s => s.id === result.currentStep)
      setCurrentStepIndex(stepIndex >= 0 ? stepIndex : 0)
    } catch (err: any) {
      setError(err.message ?? 'Failed to start onboarding')
    } finally {
      setLoading(false)
    }
  }

  const handleStepSubmit = async (data: Record<string, unknown>) => {
    if (!session) return
    try {
      const result = await stepMutation.mutateAsync({
        sessionId: session.sessionId,
        step: STEPS[currentStepIndex].id,
        data,
      })
      setSession(result)
      if (result.currentStep !== STEPS[currentStepIndex].id) {
        const nextIndex = STEPS.findIndex(s => s.id === result.currentStep)
        setCurrentStepIndex(nextIndex >= 0 ? nextIndex : currentStepIndex)
      }
    } catch (err: any) {
      setError(err.message ?? 'Failed to advance step')
    }
  }

  const handleComplete = async () => {
    if (!session) return
    try {
      const result = await completeMutation.mutateAsync({ sessionId: session.sessionId })
      if (result.teamId) {
        router.push(`/dashboard?teamId=${result.teamId}`)
      } else {
        router.push('/dashboard')
      }
    } catch (err: any) {
      setError(err.message ?? 'Failed to complete onboarding')
    }
  }

  const renderStep = () => {
    const step = STEPS[currentStepIndex]
    switch (step.id) {
      case 'app-detection':
        return <AppDetectionStep onSubmit={handleStepSubmit} />
      case 'monitor-selection':
        return <MonitorSelectionStep onSubmit={handleStepSubmit} />
      case 'alert-config':
        return <AlertConfigStep onSubmit={handleStepSubmit} />
      case 'team-invite':
        return <TeamInviteStep onSubmit={handleStepSubmit} />
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-brand" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
            <h2 className="mt-4 text-center text-xl font-semibold">Onboarding Error</h2>
            <p className="mt-2 text-center text-muted-foreground">{error}</p>
            <Button className="mt-6 w-full" onClick={loadOrCreateSession}>Retry</Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!session) {
    return null
  }

  if (session.completed) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <Check className="mx-auto h-12 w-12 text-green-500" />
            <h2 className="mt-4 text-center text-xl font-semibold">Onboarding Complete!</h2>
            <p className="mt-2 text-center text-muted-foreground">
              Your team has been created. Redirecting to dashboard...
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-8 md:py-12">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold tracking-tight">Welcome to Nightlamp</h1>
          <p className="mt-2 text-muted-foreground">
            Let's set up your monitoring in a few quick steps
          </p>
        </div>

        <div className="mb-8 flex items-center justify-center gap-2">
          {STEPS.map((step, index) => (
            <div key={step.id} className="flex items-center">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                  index < currentStepIndex
                    ? 'bg-green-500 text-white'
                    : index === currentStepIndex
                    ? 'bg-brand text-brand-foreground'
                    : 'bg-surface-tertiary text-muted-foreground'
                )}
              >
                {index < currentStepIndex ? <Check className="h-4 w-4" /> : index + 1}
              </div>
              {index < STEPS.length - 1 && (
                <div
                  className={cn(
                    'h-1 w-16 md:w-24',
                    index < currentStepIndex ? 'bg-green-500' : 'bg-border'
                  )}
                />
              )}
            </div>
          ))}
        </div>

        <div className="mb-6 flex items-center justify-between text-sm text-muted-foreground">
          <span>{STEPS[currentStepIndex].label}</span>
          <span>Step {currentStepIndex + 1} of {STEPS.length}</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{STEPS[currentStepIndex].label}</CardTitle>
          </CardHeader>
          <CardContent>{renderStep()}</CardContent>
        </Card>

        <div className="mt-6 flex justify-between">
          <Button
            variant="outline"
            onClick={() => setCurrentStepIndex(Math.max(0, currentStepIndex - 1))}
            disabled={currentStepIndex === 0 || startMutation.isPending || stepMutation.isPending}
          >
            Back
          </Button>
          {currentStepIndex === STEPS.length - 1 ? (
            <Button
              onClick={handleComplete}
              disabled={completeMutation.isPending}
            >
              {completeMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Completing...
                </>
              ) : (
                'Complete Setup'
              )}
            </Button>
          ) : (
            <Button
              onClick={() => setCurrentStepIndex(Math.min(STEPS.length - 1, currentStepIndex + 1))}
              disabled={stepMutation.isPending}
            >
              Next
              <ChevronRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function AppDetectionStep({ onSubmit }: { onSubmit: (data: Record<string, unknown>) => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        Help us understand your application so we can tailor the monitoring setup.
      </p>
      <div className="space-y-4">
        <div>
          <label htmlFor="app-name" className="block text-sm font-medium mb-1">
            Application Name
          </label>
          <input
            id="app-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="My Awesome App"
            required
          />
        </div>
        <div>
          <label htmlFor="app-url" className="block text-sm font-medium mb-1">
            Application URL (optional)
          </label>
          <input
            id="app-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="https://myapp.com"
          />
        </div>
      </div>
      <Button
        onClick={() => onSubmit({ appName: name, appUrl: url })}
        disabled={!name.trim()}
        className="w-full"
      >
        Continue
      </Button>
    </div>
  )
}

function MonitorSelectionStep({ onSubmit }: { onSubmit: (data: Record<string, unknown>) => void }) {
  const [monitors, setMonitors] = useState<string[]>([])

  const availableMonitors = [
    { id: 'sentry', name: 'Sentry', description: 'Error tracking and performance monitoring' },
    { id: 'uptimerobot', name: 'UptimeRobot', description: 'Uptime and downtime monitoring' },
  ] as const

  const toggleMonitor = (id: string) => {
    setMonitors(prev => prev.includes(id) ? prev.filter(m => m !== id) : [...prev, id])
  }

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        Select the monitoring services you want to connect. You can add more later.
      </p>
      <div className="space-y-3">
        {availableMonitors.map(monitor => (
          <label
            key={monitor.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface-secondary/40 p-4 transition-colors hover:border-brand/50"
          >
            <input
              type="checkbox"
              checked={monitors.includes(monitor.id)}
              onChange={() => toggleMonitor(monitor.id)}
              className="h-4 w-4 rounded border-border text-brand focus:ring-brand"
            />
            <div>
              <p className="font-medium">{monitor.name}</p>
              <p className="text-sm text-muted-foreground">{monitor.description}</p>
            </div>
          </label>
        ))}
      </div>
      <Button
        onClick={() => onSubmit({ monitors })}
        disabled={monitors.length === 0}
        className="w-full"
      >
        Continue
      </Button>
    </div>
  )
}

function AlertConfigStep({ onSubmit }: { onSubmit: (data: Record<string, unknown>) => void }) {
  const [email, setEmail] = useState('')
  const [slackWebhook, setSlackWebhook] = useState('')

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        Configure how you want to be notified about incidents.
      </p>
      <div className="space-y-4">
        <div>
          <label htmlFor="alert-email" className="block text-sm font-medium mb-1">
            Email Address
          </label>
          <input
            id="alert-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="alerts@mycompany.com"
          />
        </div>
        <div>
          <label htmlFor="slack-webhook" className="block text-sm font-medium mb-1">
            Slack Webhook URL (optional)
          </label>
          <input
            id="slack-webhook"
            type="url"
            value={slackWebhook}
            onChange={(e) => setSlackWebhook(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            placeholder="https://hooks.slack.com/services/..."
          />
        </div>
      </div>
      <Button
        onClick={() => onSubmit({ email: email || undefined, slackWebhook: slackWebhook || undefined })}
        className="w-full"
      >
        Continue
      </Button>
    </div>
  )
}

function TeamInviteStep({ onSubmit }: { onSubmit: (data: Record<string, unknown>) => void }) {
  const [emails, setEmails] = useState<string>('')

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground">
        Invite team members to collaborate on monitoring. You can skip this step and invite later.
      </p>
      <div>
        <label htmlFor="team-emails" className="block text-sm font-medium mb-1">
          Email Addresses (comma separated)
        </label>
        <textarea
          id="team-emails"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          className="w-full min-h-[100px] rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="teammate1@company.com, teammate2@company.com"
        />
      </div>
      <Button
        onClick={() => {
          const members = emails
            .split(',')
            .map(e => e.trim())
            .filter(Boolean)
            .map(email => ({ email }))
          onSubmit({ members })
        }}
        className="w-full"
      >
        Continue
      </Button>
    </div>
  )
}