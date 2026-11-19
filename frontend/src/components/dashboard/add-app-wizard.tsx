'use client'

import React, { useState } from 'react'
import { X, Check, Loader2, AlertCircle, Wifi, Server, Globe, Database, Github, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { trpc } from '@/lib/trpc'

type WizardStep = 'details' | 'platform' | 'check' | 'alerts' | 'test' | 'complete'

interface Platform {
  id: string
  name: string
  icon: React.ReactNode
  description: string
}

interface CheckType {
  id: string
  name: string
  description: string
}

interface Channel {
  id: string
  name: string
  type: string
  enabled: boolean
}

const PLATFORMS: Platform[] = [
  { id: 'vercel', name: 'Vercel', icon: <Zap className="size-5" />, description: 'Next.js, static sites, serverless functions' },
  { id: 'railway', name: 'Railway', icon: <Server className="size-5" />, description: 'Container deployments, databases, background workers' },
  { id: 'heroku', name: 'Heroku', icon: <Wifi className="size-5" />, description: 'Classic PaaS, dynos, add-ons' },
  { id: 'aws', name: 'AWS', icon: <Globe className="size-5" />, description: 'EC2, ECS, Lambda, Elastic Beanstalk' },
  { id: 'gcp', name: 'Google Cloud', icon: <Database className="size-5" />, description: 'Cloud Run, App Engine, Cloud Functions' },
  { id: 'azure', name: 'Azure', icon: <Github className="size-5" />, description: 'App Service, Functions, Container Instances' },
  { id: 'custom', name: 'Custom / Other', icon: <Server className="size-5" />, description: 'Any HTTP/TCP endpoint you can reach' },
]

const CHECK_TYPES: CheckType[] = [
  { id: 'http', name: 'HTTP Health Check', description: 'GET/POST request to a health endpoint, validate status code and response' },
  { id: 'tcp', name: 'TCP Port Check', description: 'Verify a TCP port is open and accepting connections' },
  { id: 'keyword', name: 'Keyword Check', description: 'HTTP request + search response body for a keyword (e.g., "healthy")' },
]

const ALERT_CHANNEL_TYPE_LABELS: Record<string, string> = {
  'email-smtp': 'Email',
  'slack-webhook': 'Slack',
  'in-app-websocket': 'In-app',
}

interface WizardData {
  appName: string
  appUrl: string
  platform: string
  checkType: string
  checkUrl: string
  keyword: string
  checkInterval: number
  alertChannelId: string
}

const INITIAL_DATA: WizardData = {
  appName: '',
  appUrl: '',
  platform: '',
  checkType: 'http',
  checkUrl: '',
  keyword: '',
  checkInterval: 60,
  alertChannelId: '',
}

export function AddAppWizard({ onClose, onSuccess }: { onClose: () => void; onSuccess?: () => void }) {
  const [step, setStep] = useState<WizardStep>('details')
  const [data, setData] = useState<WizardData>(INITIAL_DATA)
  const [errors, setErrors] = useState<Partial<Record<keyof WizardData, string>>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [testDetails, setTestDetails] = useState<{ statusCode?: number; latencyMs?: number; error?: string } | null>(null)
  const [createdAppId, setCreatedAppId] = useState<string | null>(null)
  const [isPersistedCheckRunning, setIsPersistedCheckRunning] = useState(false)

  const createMonitor = trpc.monitors.create.useMutation({
    onMutate: async (variables) => {
      setIsSubmitting(true)
      setErrors({})
    },
    onSuccess: async (app) => {
      setCreatedAppId(app.id)
      setIsSubmitting(false)
      setIsPersistedCheckRunning(true)
      setTestResult('running')
      setTestDetails(null)
      try {
        const result = await testCheckPersisted.mutateAsync({ appId: app.id })
        const passed = result.status === 'pass'
        setTestResult(passed ? 'success' : 'error')
        setTestDetails({
          statusCode: result.statusCode ?? undefined,
          latencyMs: result.latencyMs,
          error: result.errorDetail ?? undefined,
        })
        if (passed) {
          showToast('App added successfully', `${data.appName} is now being monitored`)
          onSuccess?.()
          setTimeout(() => resetWizard(), 2000)
        } else {
          const message = result.errorDetail || result.errorType || 'Persisted check failed. The app was created but the test check failed.'
          showToast('Persisted check failed', message, 'destructive')
          setErrors({ checkUrl: message })
        }
      } catch (err) {
        setTestResult('error')
        const message = err instanceof Error ? err.message : 'Persisted check failed'
        setTestDetails({ error: message })
        showToast('Persisted check failed', message, 'destructive')
        setErrors({ checkUrl: message })
      } finally {
        setIsPersistedCheckRunning(false)
      }
    },
    onError: (err) => {
      setIsSubmitting(false)
      showToast('Failed to add app', err.message, 'destructive')
    },
  })

  const testCheckPersisted = trpc.monitors.testCheckPersisted.useMutation()

  const testCheckMutation = trpc.monitors.testCheck.useMutation({
    onSuccess: (result) => {
      const passed = result.status === 'pass'
      setTestResult(passed ? 'success' : 'error')
      setTestDetails({
        statusCode: result.statusCode ?? undefined,
        latencyMs: result.latencyMs,
        error: result.errorDetail ?? undefined,
      })
      if (passed) {
        showToast('Preview check passed', `Status: ${result.statusCode ?? 'n/a'}, Latency: ${result.latencyMs}ms`)
      } else {
        const message = result.errorDetail || result.errorType || 'Check failed. Verify the target and try again.'
        showToast('Preview check failed', message, 'destructive')
        setErrors({ checkUrl: message })
      }
    },
    onError: (err) => {
      setTestResult('error')
      setTestDetails({ error: err.message })
      showToast('Preview check failed', err.message, 'destructive')
      setErrors({ checkUrl: err.message })
    },
  })

  const channelsQuery = trpc.monitors.channels.useQuery()

  const createChannelMutation = trpc.monitors.createChannel.useMutation({
    onSuccess: (channel) => {
      showToast('Alert channel created', channel.name)
      setData((current) => ({ ...current, alertChannelId: channel.id }))
      channelsQuery.refetch()
    },
    onError: (err) => {
      showToast('Failed to create alert channel', err.message, 'destructive')
    },
  })

  const showToast = (title: string, description: string, variant?: 'default' | 'destructive') => {
    if (variant === 'destructive') {
      toast.error(title, { description })
    } else {
      toast.success(title, { description })
    }
  }

  const validateStep = (currentStep: WizardStep): boolean => {
    const newErrors: Partial<Record<keyof WizardData, string>> = {}

    switch (currentStep) {
      case 'details':
        if (!data.appName.trim()) newErrors.appName = 'Application name is required'
        if (!data.appUrl.trim()) newErrors.appUrl = 'Application URL is required'
        else if (!/^https?:\/\//.test(data.appUrl)) newErrors.appUrl = 'URL must start with http:// or https://'
        break
      case 'platform':
        if (!data.platform) newErrors.platform = 'Please select a platform'
        break
      case 'check':
        if (!data.checkUrl.trim()) newErrors.checkUrl = 'Check URL is required'
        else if (data.checkType === 'tcp' && !/^[^/\s]+:\d+$/.test(data.checkUrl)) newErrors.checkUrl = 'TCP targets must use host:port format'
        else if (data.checkType !== 'tcp' && !/^https?:\/\//.test(data.checkUrl)) newErrors.checkUrl = 'URL must start with http:// or https://'
        if (data.checkType === 'keyword' && !data.keyword.trim()) newErrors.keyword = 'Expected keyword is required for keyword checks'
        if (data.checkInterval < 10) newErrors.checkInterval = 'Interval must be at least 10 seconds'
        break
      case 'alerts':
        if (!data.alertChannelId) newErrors.alertChannelId = 'Select an alert channel'
        break
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const nextStep = () => {
    if (validateStep(step)) {
      const steps: WizardStep[] = ['details', 'platform', 'check', 'alerts', 'test']
      const currentIndex = steps.indexOf(step)
      if (currentIndex < steps.length - 1) {
        setStep(steps[currentIndex + 1])
      }
    }
  }

  const prevStep = () => {
    const steps: WizardStep[] = ['details', 'platform', 'check', 'alerts', 'test']
    const currentIndex = steps.indexOf(step)
    if (currentIndex > 0) {
      setStep(steps[currentIndex - 1])
    }
  }

  const handleTestCheck = async () => {
    setTestResult('running')
    setErrors({})
    setTestDetails(null)

    await testCheckMutation.mutateAsync({
      checkTarget: data.checkUrl,
      checkType: data.checkType as 'http' | 'tcp' | 'keyword',
      checkTimeoutSec: 10,
      keyword: data.checkType === 'keyword' ? data.keyword : undefined,
    })
  }

  const handleRetryPersistedCheck = async () => {
    if (!createdAppId) return
    setIsPersistedCheckRunning(true)
    setTestResult('running')
    setTestDetails(null)
    setErrors({})
    try {
      const result = await testCheckPersisted.mutateAsync({ appId: createdAppId })
      const passed = result.status === 'pass'
      setTestResult(passed ? 'success' : 'error')
      setTestDetails({
        statusCode: result.statusCode ?? undefined,
        latencyMs: result.latencyMs,
        error: result.errorDetail ?? undefined,
      })
      if (passed) {
        showToast('App added successfully', `${data.appName} is now being monitored`)
        onSuccess?.()
        setTimeout(() => resetWizard(), 2000)
      } else {
        const message = result.errorDetail || result.errorType || 'Persisted check failed. The app was created but the test check failed.'
        showToast('Persisted check failed', message, 'destructive')
        setErrors({ checkUrl: message })
      }
    } catch (err) {
      setTestResult('error')
      const message = err instanceof Error ? err.message : 'Persisted check failed'
      setTestDetails({ error: message })
      showToast('Persisted check failed', message, 'destructive')
      setErrors({ checkUrl: message })
    } finally {
      setIsPersistedCheckRunning(false)
    }
  }

  const handleSubmit = async () => {
    if (!validateStep(step)) return

    setIsSubmitting(true)
    setErrors({})

    await createMonitor.mutateAsync({
      name: data.appName,
      url: data.appUrl,
      platform: data.platform,
      checkType: data.checkType as 'http' | 'tcp' | 'keyword',
      checkTarget: data.checkUrl,
      checkIntervalSec: data.checkInterval,
      keyword: data.checkType === 'keyword' ? data.keyword : undefined,
      alertChannelId: data.alertChannelId,
      enabled: true,
    })
  }

  const resetWizard = () => {
    setStep('details')
    setData(INITIAL_DATA)
    setErrors({})
    setTestResult('idle')
    setCreatedAppId(null)
    setIsPersistedCheckRunning(false)
  }

  const steps: { key: WizardStep; label: string }[] = [
    { key: 'details', label: 'App Details' },
    { key: 'platform', label: 'Platform' },
    { key: 'check', label: 'Check Config' },
    { key: 'alerts', label: 'Alerts' },
    { key: 'test', label: 'Test & Confirm' },
  ]

  const currentStepIndex = steps.findIndex((s) => s.key === step)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => { resetWizard(); onClose(); }}
        aria-hidden
      />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-surface-primary border border-border rounded-xl shadow-elevation-3">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Add New App</h2>
            <p className="text-sm text-muted-foreground">
              Step {currentStepIndex + 1} of {steps.length}: {steps[currentStepIndex].label}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => { resetWizard(); onClose(); }}
            aria-label="Close wizard"
            disabled={isSubmitting}
          >
            <X className="size-4" />
          </Button>
        </div>

        {/* Progress Indicator */}
        <div className="border-b border-border px-6 py-3">
          <div className="flex items-center justify-between">
            {steps.map((s, i) => (
              <React.Fragment key={s.key}>
                <div className="flex items-center">
                  <div
                    className={cn(
                      'w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors',
                      i < currentStepIndex
                        ? 'bg-success text-white'
                        : i === currentStepIndex
                        ? 'bg-brand text-white ring-2 ring-brand ring-offset-2 ring-offset-surface-primary'
                        : 'bg-surface-tertiary text-muted-foreground'
                    )}
                  >
                    {i < currentStepIndex ? <Check className="size-4" /> : i + 1}
                  </div>
                  {i < steps.length - 1 && (
                    <div
                      className={cn(
                        'hidden md:block w-16 h-0.5 mx-2 transition-colors',
                        i < currentStepIndex ? 'bg-success' : 'bg-border'
                      )}
                    />
                  )}
                </div>
              </React.Fragment>
            ))}
          </div>
          <div className="mt-2 hidden md:block">
            <div className="h-1 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-brand transition-all duration-300"
                style={{ width: `${((currentStepIndex) / (steps.length - 1)) * 100}%` }}
              />
            </div>
          </div>
        </div>

        {/* Step Content */}
        <div className="p-6">
          {step === 'details' && (
            <DetailsStep data={data} setData={setData} errors={errors} />
          )}
          {step === 'platform' && (
            <PlatformStep data={data} setData={setData} errors={errors} />
          )}
          {step === 'check' && (
            <CheckStep data={data} setData={setData} errors={errors} />
          )}
          {step === 'alerts' && (
            <AlertsStep
              data={data}
              setData={setData}
              errors={errors}
              channels={channelsQuery.data?.channels ?? []}
              isLoadingChannels={channelsQuery.isLoading}
              onCreateChannel={() => createChannelMutation.mutate({
                name: 'Nightlamp in-app alerts',
                type: 'in-app-websocket',
                config: {},
              })}
              isCreatingChannel={createChannelMutation.isPending}
            />
          )}
          {step === 'test' && (
            <TestStep
              data={data}
              testResult={testResult}
              onTest={handleTestCheck}
              errors={errors}
              testDetails={testDetails}
              isTesting={testCheckMutation.isPending}
              channels={channelsQuery.data?.channels ?? []}
              isPersistedCheck={createdAppId !== null}
              isPersistedCheckRunning={isPersistedCheckRunning}
              onRetryPersistedCheck={handleRetryPersistedCheck}
            />
          )}
          {step === 'complete' && (
            <CompleteStep onClose={() => { resetWizard(); onClose(); }} />
          )}
        </div>

        {/* Navigation */}
        <div className="border-t border-border px-6 py-4 flex items-center justify-between">
          <Button
            variant="outline"
            onClick={prevStep}
            disabled={step === 'details' || isSubmitting}
            className="hidden sm:block"
          >
            Previous
          </Button>
          <div className="flex gap-2 sm:ml-auto">
            {step === 'test' ? (
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting}
                className="min-w-[120px]"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add App'
                )}
              </Button>
            ) : step !== 'complete' ? (
              <Button onClick={nextStep} disabled={isSubmitting}>
                Next
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Mobile Previous Button */}
      {step !== 'details' && step !== 'complete' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 sm:hidden z-40">
          <Button variant="outline" onClick={prevStep} disabled={isSubmitting}>
            Previous
          </Button>
        </div>
      )}
    </div>
  )
}

function DetailsStep({ data, setData, errors }: { data: WizardData; setData: React.Dispatch<React.SetStateAction<WizardData>>; errors: Partial<Record<keyof WizardData, string>> }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Application Details</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Enter the basic information for your application.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="appName">Application Name *</Label>
          <Input
            id="appName"
            value={data.appName}
            onChange={(e) => setData({ ...data, appName: e.target.value })}
            placeholder="e.g., My Production App"
            className={cn(errors.appName ? 'border-destructive focus-visible:ring-destructive' : '', 'text-base h-11')}
            aria-invalid={!!errors.appName}
            aria-describedby={errors.appName ? 'appName-error' : undefined}
          />
          {errors.appName && (
            <p id="appName-error" className="text-sm text-destructive" role="alert">
              {errors.appName}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="appUrl">Application URL *</Label>
          <Input
            id="appUrl"
            type="url"
            value={data.appUrl}
            onChange={(e) => setData({ ...data, appUrl: e.target.value })}
            placeholder="https://myapp.example.com"
            className={cn(errors.appUrl ? 'border-destructive focus-visible:ring-destructive' : '', 'text-base h-11')}
            aria-invalid={!!errors.appUrl}
            aria-describedby={errors.appUrl ? 'appUrl-error' : undefined}
          />
          {errors.appUrl && (
            <p id="appUrl-error" className="text-sm text-destructive" role="alert">
              {errors.appUrl}
            </p>
          )}
        </div>
      </div>

      <Card className="border-border bg-surface-secondary/50">
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            <strong>Tip:</strong> Use the base URL of your application. We&apos;ll use this to construct health check endpoints
            and for display purposes in the dashboard.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function PlatformStep({ data, setData, errors }: { data: WizardData; setData: React.Dispatch<React.SetStateAction<WizardData>>; errors: Partial<Record<keyof WizardData, string>> }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Select Platform</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Choose where your application is hosted. This helps us configure the right monitoring defaults.
        </p>
      </div>

      {errors.platform && (
        <div className="text-sm text-destructive" role="alert">{errors.platform}</div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {PLATFORMS.map((platform) => (
          <Button
            key={platform.id}
            variant={data.platform === platform.id ? 'default' : 'outline'}
            className={cn(
              'h-24 flex-col items-start gap-3 text-left w-full',
              data.platform === platform.id && 'border-brand bg-brand/10'
            )}
            onClick={() => setData({ ...data, platform: platform.id })}
          >
            <div className="flex items-center gap-3">
              <div className="size-10 flex items-center justify-center rounded-lg bg-surface-secondary">
                {platform.icon}
              </div>
              <div>
                <p className="font-medium">{platform.name}</p>
                <p className="text-xs text-muted-foreground">{platform.description}</p>
              </div>
            </div>
            {data.platform === platform.id && (
              <Check className="size-4 text-success" aria-hidden />
            )}
          </Button>
        ))}
      </div>
    </div>
  )
}

function CheckStep({ data, setData, errors }: { data: WizardData; setData: React.Dispatch<React.SetStateAction<WizardData>>; errors: Partial<Record<keyof WizardData, string>> }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Configure First Check</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Set up the initial monitoring check for your application.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Check Type *</Label>
          <RadioGroup
            value={data.checkType}
            onValueChange={(value) => setData({ ...data, checkType: value })}
            className="space-y-3"
          >
            {CHECK_TYPES.map((check) => (
              <div key={check.id} className="flex items-start gap-3 p-3 border rounded-lg hover:border-glow-500/50 transition-colors">
                <RadioGroupItem value={check.id} className="mt-0.5" />
                <div>
                  <p className="font-medium">{check.name}</p>
                  <p className="text-sm text-muted-foreground">{check.description}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
        </div>

        <div className="space-y-2">
          <Label htmlFor="checkUrl">Check URL *</Label>
          <Input
            id="checkUrl"
            type="url"
            value={data.checkUrl}
            onChange={(e) => setData({ ...data, checkUrl: e.target.value })}
            placeholder={data.checkType === 'tcp' ? 'example.com:443' : 'https://myapp.example.com/health'}
            className={cn(errors.checkUrl ? 'border-destructive focus-visible:ring-destructive' : '', 'text-base h-11')}
            aria-invalid={!!errors.checkUrl}
            aria-describedby={errors.checkUrl ? 'checkUrl-error' : undefined}
          />
          {errors.checkUrl && (
            <p id="checkUrl-error" className="text-sm text-destructive" role="alert">
              {errors.checkUrl}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {data.checkType === 'tcp'
              ? 'Enter host:port (e.g., api.example.com:443)'
              : 'Enter the full URL to your health endpoint'}
          </p>
        </div>

        {data.checkType === 'keyword' && (
          <div className="space-y-2">
            <Label htmlFor="checkKeyword">Expected Keyword *</Label>
            <Input
              id="checkKeyword"
              value={data.keyword}
              onChange={(e) => setData({ ...data, keyword: e.target.value })}
              placeholder="healthy"
              className={cn(errors.keyword ? 'border-destructive focus-visible:ring-destructive' : '', 'text-base h-11')}
              aria-invalid={!!errors.keyword}
              aria-describedby={errors.keyword ? 'checkKeyword-error' : undefined}
            />
            {errors.keyword && (
              <p id="checkKeyword-error" className="text-sm text-destructive" role="alert">
                {errors.keyword}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              The check passes when the response body contains this text.
            </p>
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="checkInterval">Check Interval (seconds) *</Label>
          <Input
            id="checkInterval"
            type="number"
            min="10"
            max="3600"
            value={data.checkInterval}
            onChange={(e) => setData({ ...data, checkInterval: parseInt(e.target.value) || 10 })}
            className={cn(errors.checkInterval ? 'border-destructive focus-visible:ring-destructive' : '', 'text-base h-11')}
            aria-invalid={!!errors.checkInterval}
          />
          {errors.checkInterval && (
            <p className="text-sm text-destructive" role="alert">{errors.checkInterval}</p>
          )}
          <p className="text-xs text-muted-foreground">How often to run this check (minimum 10 seconds)</p>
        </div>
      </div>

      <Card className="border-border bg-surface-secondary/50">
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            <strong>Recommendation:</strong> Start with an HTTP health check on your <code>/health</code> or <code>/ready</code>
            endpoint with a 60-second interval. You can add more checks later from the Monitoring page.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function AlertsStep({
  data,
  setData,
  errors,
  channels,
  isLoadingChannels,
  onCreateChannel,
  isCreatingChannel,
}: {
  data: WizardData
  setData: React.Dispatch<React.SetStateAction<WizardData>>
  errors: Partial<Record<keyof WizardData, string>>
  channels: Channel[]
  isLoadingChannels: boolean
  onCreateChannel: () => void
  isCreatingChannel: boolean
}) {
  const selectableChannels = channels.filter((channel) => channel.enabled)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Configure Alerts</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Choose the notification channel that receives alerts for this application.
        </p>
      </div>

      {errors.alertChannelId && (
        <div className="text-sm text-destructive" role="alert">{errors.alertChannelId}</div>
      )}

      {isLoadingChannels ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading alert channels...
        </div>
      ) : selectableChannels.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            No notification channels are configured yet. Create one to receive alerts for this application.
          </p>
          <Button type="button" variant="outline" onClick={onCreateChannel} disabled={isCreatingChannel}>
            {isCreatingChannel ? (
              <>
                <Loader2 className="size-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              'Create in-app alerts channel'
            )}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {selectableChannels.map((channel) => (
            <button
              type="button"
              key={channel.id}
              onClick={() => setData({ ...data, alertChannelId: channel.id })}
              className={cn(
                'w-full text-left flex items-center justify-between p-3 border rounded-lg transition-colors',
                data.alertChannelId === channel.id
                  ? 'border-brand bg-brand/10'
                  : 'border-border hover:border-glow-500/50'
              )}
              aria-pressed={data.alertChannelId === channel.id}
            >
              <div className="flex items-center gap-3">
                <div className="size-9 flex items-center justify-center rounded-lg bg-surface-secondary">
                  <Wifi className="size-4" />
                </div>
                <div>
                  <p className="font-medium">{channel.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {ALERT_CHANNEL_TYPE_LABELS[channel.type] ?? channel.type}
                  </p>
                </div>
              </div>
              {data.alertChannelId === channel.id && (
                <Check className="size-4 text-success" aria-hidden />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TestStep({ data, testResult, onTest, errors, testDetails, isTesting, channels, isPersistedCheck, isPersistedCheckRunning, onRetryPersistedCheck }: { data: WizardData; testResult: 'idle' | 'running' | 'success' | 'error'; onTest: () => void; errors: Partial<Record<keyof WizardData, string>>; testDetails: { statusCode?: number; latencyMs?: number; error?: string } | null; isTesting: boolean; channels: Channel[]; isPersistedCheck: boolean; isPersistedCheckRunning: boolean; onRetryPersistedCheck: () => void }) {
return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Test & Confirm</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {isPersistedCheck
            ? 'The app has been created. Running the persisted test check...'
            : 'Run a test check to verify your configuration works before adding the app.'}
        </p>
      </div>

      <Card className="bg-surface-secondary/50">
        <CardContent className="pt-6 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 text-sm">
            <div>
              <p className="text-muted-foreground">Application</p>
              <p className="font-medium">{data.appName}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Platform</p>
              <p className="font-medium capitalize">{data.platform}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Check Type</p>
              <p className="font-medium capitalize">
                {CHECK_TYPES.find((c) => c.id === data.checkType)?.name}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Check URL</p>
              <p className="font-medium truncate max-w-[200px]">{data.checkUrl}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Interval</p>
              <p className="font-medium">{data.checkInterval}s</p>
            </div>
            <div>
              <p className="text-muted-foreground">Alert Channel</p>
              <p className="font-medium">
                {channels.find((channel) => channel.id === data.alertChannelId)?.name || 'None'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {!isPersistedCheck ? (
          <>
            <Button
              onClick={onTest}
              disabled={testResult === 'running' || isTesting}
              className="w-full sm:w-auto"
              size="lg"
            >
              {testResult === 'running' || isTesting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Running test check...
                </>
              ) : testResult === 'success' ? (
                <>
                  <Check className="size-4 mr-2 text-success" />
                  Test passed �?" ready to add
                </>
              ) : testResult === 'error' ? (
                <>
                  <AlertCircle className="size-4 mr-2 text-destructive" />
                  Test failed �?" retry or adjust
                </>
              ) : (
                <>
                  <Wifi className="size-4 mr-2" />
                  Run Test Check
                </>
              )}
            </Button>

            {testResult === 'error' && errors.checkUrl && (
              <p className="text-sm text-destructive" role="alert">{errors.checkUrl}</p>
            )}

            {testDetails && (
              <Card className="border-border bg-surface-secondary/50">
                <CardContent className="pt-4 pb-2 space-y-2">
                  <p className="text-sm font-medium">Test Result Details</p>
                  <div className="grid gap-2 sm:grid-cols-3 text-sm">
                    <div>
                      <p className="text-muted-foreground">Status Code</p>
                      <p className="font-medium">{testDetails.statusCode ?? 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Latency</p>
                      <p className="font-medium">{testDetails.latencyMs !== undefined ? `${testDetails.latencyMs}ms` : 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Error</p>
                      <p className="font-medium text-destructive">{testDetails.error ?? 'None'}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {testResult !== 'idle' && testResult !== 'running' && (
              <p className="text-sm text-muted-foreground">
                {testResult === 'success'
                  ? 'Your check is working correctly. Click "Add App" to start monitoring.'
                  : 'Please verify the URL and network access, then try again.'}
              </p>
            )}
          </>
        ) : (
          <>
            <Button
              onClick={onRetryPersistedCheck}
              disabled={testResult === 'running' || isPersistedCheckRunning}
              className="w-full sm:w-auto"
              size="lg"
              variant={testResult === 'success' ? 'default' : 'outline'}
            >
              {testResult === 'running' || isPersistedCheckRunning ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Running persisted check...
                </>
              ) : testResult === 'success' ? (
                <>
                  <Check className="size-4 mr-2 text-success" />
                  Persisted check passed
                </>
              ) : testResult === 'error' ? (
                <>
                  <AlertCircle className="size-4 mr-2 text-destructive" />
                  Persisted check failed �?" retry
                </>
              ) : (
                <>
                  <Wifi className="size-4 mr-2" />
                  Run Persisted Check
                </>
              )}
            </Button>

            {testResult === 'error' && errors.checkUrl && (
              <p className="text-sm text-destructive" role="alert">{errors.checkUrl}</p>
            )}

            {testDetails && (
              <Card className="border-border bg-surface-secondary/50">
                <CardContent className="pt-4 pb-2 space-y-2">
                  <p className="text-sm font-medium">Persisted Test Result Details</p>
                  <div className="grid gap-2 sm:grid-cols-3 text-sm">
                    <div>
                      <p className="text-muted-foreground">Status Code</p>
                      <p className="font-medium">{testDetails.statusCode ?? 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Latency</p>
                      <p className="font-medium">{testDetails.latencyMs !== undefined ? `${testDetails.latencyMs}ms` : 'N/A'}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Error</p>
                      <p className="font-medium text-destructive">{testDetails.error ?? 'None'}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {testResult !== 'idle' && testResult !== 'running' && (
              <p className="text-sm text-muted-foreground">
                {testResult === 'success'
                  ? 'The app is created and the persisted check passed. Monitoring is active.'
                  : 'The app was created but the persisted check failed. The app configuration is saved. You can retry the check or adjust the target.'}
              </p>
            )}
          </>
        )}
      </div>

      <Card className="border-border bg-surface-secondary/50">
        <CardContent className="pt-6">
          <p className="text-sm text-muted-foreground">
            <strong>What happens next:</strong> After adding, your app will appear in the Apps tab and the Overview dashboard.
            The first check will run within the configured interval. You can add more checks and configure advanced settings
            from the Monitoring and Settings pages.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

function CompleteStep({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <div className="size-16 mx-auto rounded-full bg-success/10 flex items-center justify-center">
        <Check className="size-8 text-success" />
      </div>
      <div>
        <h3 className="text-xl font-semibold">App Added Successfully!</h3>
        <p className="text-muted-foreground mt-2">
          Your application is now being monitored. The first check will run shortly.
        </p>
      </div>
      <Button onClick={onClose} size="lg" className="w-full sm:w-auto">
        View Dashboard
      </Button>
    </div>
  )
}