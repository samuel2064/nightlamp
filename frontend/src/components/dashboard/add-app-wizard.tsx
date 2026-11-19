'use client'

import React, { useState, useCallback } from 'react'
import { X, Check, Loader2, AlertCircle, Wifi, Server, Globe, Database, Github, Zap, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
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

interface AlertChannel {
  id: string
  name: string
  type: string
  description: string
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

const ALERT_CHANNEL_TYPES = [
  { id: 'email-smtp', name: 'Email (SMTP)', description: 'Send alerts via SMTP', configFields: ['host', 'port', 'username', 'password', 'from', 'to'] },
  { id: 'slack-webhook', name: 'Slack Webhook', description: 'Post alerts to a Slack channel via webhook', configFields: ['url'] },
  { id: 'in-app-websocket', name: 'In-App Notification', description: 'Show alerts in the dashboard', configFields: [] },
]

interface WizardData {
  appName: string
  appUrl: string
  platform: string
  checkType: string
  checkTarget: string
  checkIntervalSec: number
  checkTimeoutSec: number
  keyword: string
  alertChannelId: string
  alertChannelType: string
  alertChannelConfig: Record<string, string>
}

const INITIAL_DATA: WizardData = {
  appName: '',
  appUrl: '',
  platform: '',
  checkType: 'http',
  checkTarget: '',
  checkIntervalSec: 60,
  checkTimeoutSec: 10,
  keyword: '',
  alertChannelId: '',
  alertChannelType: '',
  alertChannelConfig: {},
}

export function AddAppWizard({ onClose, onSuccess }: { onClose: () => void; onSuccess?: () => void }) {
  const [step, setStep] = useState<WizardStep>('details')
  const [data, setData] = useState<WizardData>(INITIAL_DATA)
  const [errors, setErrors] = useState<Partial<Record<keyof WizardData, string>>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [testResult, setTestResult] = useState<'idle' | 'running' | 'success' | 'error'>('idle')
  const [createdAppId, setCreatedAppId] = useState<string | null>(null)

  const createApp = trpc.apps.create.useMutation({
    onSuccess: (result) => {
      const app = result.app
      setCreatedAppId(app.id)
      setStep('test')
      showToast('App created', `${app.name} created successfully. Now run a test check.`)
    },
    onError: (err) => {
      const message = err.message
      showToast('Failed to create app', message, 'destructive')
      setErrors({ appName: message })
    },
  })

  const testCheck = trpc.apps.testCheck.useMutation({
    onSuccess: (result) => {
      const r = result.result
      const success = r.status === 'healthy' || r.status === 'ok' || r.statusCode === 200
      setTestResult(success ? 'success' : 'error')
      if (success) {
        showToast('Test check passed', `Status ${r.statusCode} (${r.latencyMs}ms)`)
      } else {
        showToast('Test check failed', r.errorDetail || `Status ${r.statusCode}`, 'destructive')
        setErrors({ checkTarget: r.errorDetail || `Endpoint returned ${r.statusCode}` })
      }
    },
    onError: (err) => {
      setTestResult('error')
      showToast('Test check failed', err.message, 'destructive')
      setErrors({ checkTarget: err.message })
    },
  })

  const previewCheck = trpc.apps.previewCheck.useMutation({
    onSuccess: (result) => {
      const r = result.result
      const success = r.status === 'healthy' || r.status === 'ok' || r.statusCode === 200
      setTestResult(success ? 'success' : 'error')
      if (success) {
        showToast('Test check passed (preview)', `Status ${r.statusCode} (${r.latencyMs}ms)`)
      } else {
        showToast('Test check failed', r.errorDetail || `Status ${r.statusCode}`, 'destructive')
        setErrors({ checkTarget: r.errorDetail || `Endpoint returned ${r.statusCode}` })
      }
    },
    onError: (err) => {
      setTestResult('error')
      showToast('Test check failed', err.message, 'destructive')
      setErrors({ checkTarget: err.message })
    },
  })

  const createAlertChannel = trpc.notifications.createChannel.useMutation({
    onSuccess: (result) => {
      setData(prev => ({ ...prev, alertChannelId: result.id }))
      showToast('Alert channel created', `${result.name} (${result.type})`)
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

  const validateStep = useCallback((currentStep: WizardStep): boolean => {
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
        if (!data.checkTarget.trim()) newErrors.checkTarget = 'Check target is required'
        else if (!/^https?:\/\//.test(data.checkTarget) && data.checkType !== 'tcp') newErrors.checkTarget = 'Check target must be a valid URL (or host:port for TCP)'
        if (data.checkIntervalSec < 10) newErrors.checkIntervalSec = 'Interval must be at least 10 seconds'
        if (data.checkTimeoutSec < 1) newErrors.checkTimeoutSec = 'Timeout must be at least 1 second'
        if (data.checkType === 'keyword' && !data.keyword.trim()) newErrors.keyword = 'Keyword is required for keyword checks'
        break
      case 'alerts':
        if (!data.alertChannelId) newErrors.alertChannelId = 'Select or create an alert channel'
        break
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }, [data])

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

  const handlePreviewTest = async () => {
    if (!validateStep('check')) return
    setTestResult('running')
    setErrors({})
    await previewCheck.mutateAsync({
      checkType: data.checkType as 'http' | 'tcp' | 'keyword',
      checkTarget: data.checkTarget,
      checkTimeoutSec: data.checkTimeoutSec,
      keyword: data.checkType === 'keyword' ? data.keyword : undefined,
    })
  }

  const handleTestCheck = async () => {
    if (!createdAppId) {
      showToast('App not created', 'Please create the app first', 'destructive')
      return
    }
    if (!validateStep('check')) return
    setTestResult('running')
    setErrors({})
    await testCheck.mutateAsync({
      appId: createdAppId,
      checkType: data.checkType as 'http' | 'tcp' | 'keyword',
      checkTarget: data.checkTarget,
      checkTimeoutSec: data.checkTimeoutSec,
      keyword: data.checkType === 'keyword' ? data.keyword : undefined,
    })
  }

  const handleCreateAlertChannel = async () => {
    if (!data.alertChannelType) {
      setErrors({ alertChannelType: 'Select a channel type' })
      return
    }
    if (data.alertChannelType === 'email-smtp' && !data.alertChannelConfig.host) {
      setErrors({ alertChannelConfig: 'SMTP host is required' })
      return
    }
    if (data.alertChannelType === 'slack-webhook' && !data.alertChannelConfig.url) {
      setErrors({ alertChannelConfig: 'Slack webhook URL is required' })
      return
    }
    await createAlertChannel.mutateAsync({
      name: `${data.appName} - ${data.alertChannelType}`,
      type: data.alertChannelType as 'email-smtp' | 'slack-webhook' | 'in-app-websocket',
      config: data.alertChannelConfig,
    })
  }

  const handleSubmit = async () => {
    if (!validateStep(step)) return

    setIsSubmitting(true)
    setErrors({})

    await createApp.mutateAsync({
      name: data.appName,
      url: data.appUrl,
      platform: data.platform as 'vercel' | 'railway' | 'heroku' | 'aws' | 'gcp' | 'azure' | 'custom',
      checkType: data.checkType as 'http' | 'tcp' | 'keyword',
      checkTarget: data.checkTarget,
      checkIntervalSec: data.checkIntervalSec,
      checkTimeoutSec: data.checkTimeoutSec,
      keyword: data.checkType === 'keyword' ? data.keyword : undefined,
      enabled: true,
      alertChannelId: data.alertChannelId,
    })
  }

  const resetWizard = () => {
    setStep('details')
    setData(INITIAL_DATA)
    setErrors({})
    setTestResult('idle')
    setCreatedAppId(null)
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
            disabled={isSubmitting || createApp.isPending}
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
              onCreateChannel={handleCreateAlertChannel}
              creating={createAlertChannel.isPending}
            />
          )}
          {step === 'test' && (
            <TestStep
              data={data}
              testResult={testResult}
              onPreviewTest={handlePreviewTest}
              onTestCheck={handleTestCheck}
              previewPending={previewCheck.isPending}
              testPending={testCheck.isPending}
              errors={errors}
              createdAppId={createdAppId}
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
            disabled={step === 'details' || isSubmitting || createApp.isPending}
            className="hidden sm:block"
          >
            Previous
          </Button>
          <div className="flex gap-2 sm:ml-auto">
            {step === 'test' ? (
              <Button
                onClick={handleSubmit}
                disabled={isSubmitting || createApp.isPending}
                className="min-w-[120px]"
              >
                {isSubmitting || createApp.isPending ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    Adding...
                  </>
                ) : (
                  'Add App'
                )}
              </Button>
            ) : step !== 'complete' ? (
              <Button onClick={nextStep} disabled={isSubmitting || (step === 'check' && previewCheck.isPending)}>
                Next
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Mobile Previous Button */}
      {step !== 'details' && step !== 'complete' && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 sm:hidden z-40">
          <Button variant="outline" onClick={prevStep} disabled={isSubmitting || createApp.isPending}>
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
            className={errors.appName ? 'border-destructive focus-visible:ring-destructive' : undefined}
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
            className={errors.appUrl ? 'border-destructive focus-visible:ring-destructive' : undefined}
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
            onValueChange={(value) => setData({ ...data, checkType: value, checkTarget: '', keyword: '' })}
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
          <Label htmlFor="checkTarget">Check Target *</Label>
          <Input
            id="checkTarget"
            type={data.checkType === 'tcp' ? 'text' : 'url'}
            value={data.checkTarget}
            onChange={(e) => setData({ ...data, checkTarget: e.target.value })}
            placeholder={data.checkType === 'tcp' ? 'example.com:443' : 'https://myapp.example.com/health'}
            className={errors.checkTarget ? 'border-destructive focus-visible:ring-destructive' : undefined}
            aria-invalid={!!errors.checkTarget}
            aria-describedby={errors.checkTarget ? 'checkTarget-error' : undefined}
          />
          {errors.checkTarget && (
            <p id="checkTarget-error" className="text-sm text-destructive" role="alert">
              {errors.checkTarget}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {data.checkType === 'tcp'
              ? 'Enter host:port (e.g., api.example.com:443)'
              : 'Enter the full URL to your health endpoint'}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="checkIntervalSec">Check Interval (seconds) *</Label>
          <Input
            id="checkIntervalSec"
            type="number"
            min="10"
            max="86400"
            value={data.checkIntervalSec}
            onChange={(e) => setData({ ...data, checkIntervalSec: parseInt(e.target.value) || 10 })}
            className={errors.checkIntervalSec ? 'border-destructive focus-visible:ring-destructive' : undefined}
            aria-invalid={!!errors.checkIntervalSec}
          />
          {errors.checkIntervalSec && (
            <p className="text-sm text-destructive" role="alert">{errors.checkIntervalSec}</p>
          )}
          <p className="text-xs text-muted-foreground">How often to run this check (minimum 10 seconds)</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="checkTimeoutSec">Check Timeout (seconds) *</Label>
          <Input
            id="checkTimeoutSec"
            type="number"
            min="1"
            max="30"
            value={data.checkTimeoutSec}
            onChange={(e) => setData({ ...data, checkTimeoutSec: parseInt(e.target.value) || 10 })}
            className={errors.checkTimeoutSec ? 'border-destructive focus-visible:ring-destructive' : undefined}
            aria-invalid={!!errors.checkTimeoutSec}
          />
          {errors.checkTimeoutSec && (
            <p className="text-sm text-destructive" role="alert">{errors.checkTimeoutSec}</p>
          )}
          <p className="text-xs text-muted-foreground">Timeout for each check attempt (1-30 seconds)</p>
        </div>

        {data.checkType === 'keyword' && (
          <div className="space-y-2">
            <Label htmlFor="keyword">Keyword *</Label>
            <Input
              id="keyword"
              value={data.keyword}
              onChange={(e) => setData({ ...data, keyword: e.target.value })}
              placeholder="e.g., healthy"
              className={errors.keyword ? 'border-destructive focus-visible:ring-destructive' : undefined}
              aria-invalid={!!errors.keyword}
              aria-describedby={errors.keyword ? 'keyword-error' : undefined}
            />
            {errors.keyword && (
              <p id="keyword-error" className="text-sm text-destructive" role="alert">
                {errors.keyword}
              </p>
            )}
            <p className="text-xs text-muted-foreground">Keyword to search for in the response body</p>
          </div>
        )}

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
  onCreateChannel,
  creating,
}: {
  data: WizardData
  setData: React.Dispatch<React.SetStateAction<WizardData>>
  errors: Partial<Record<keyof WizardData, string>>
  onCreateChannel: () => Promise<void>
  creating: boolean
}) {
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [channelFormErrors, setChannelFormErrors] = useState<Record<string, string>>({})

  const handleConfigChange = (key: string, value: string) => {
    setData(prev => ({
      ...prev,
      alertChannelConfig: { ...prev.alertChannelConfig, [key]: value },
    }))
    if (channelFormErrors[key]) {
      setChannelFormErrors(prev => ({ ...prev, [key]: '' }))
    }
  }

  const handleCreate = async () => {
    const newErrors: Record<string, string> = {}
    if (!data.alertChannelType) {
      newErrors.type = 'Select a channel type'
    }
    if (data.alertChannelType === 'email-smtp') {
      if (!data.alertChannelConfig.host) newErrors.host = 'SMTP host is required'
      if (!data.alertChannelConfig.port) newErrors.port = 'SMTP port is required'
      if (!data.alertChannelConfig.username) newErrors.username = 'Username is required'
      if (!data.alertChannelConfig.password) newErrors.password = 'Password is required'
      if (!data.alertChannelConfig.from) newErrors.from = 'From address is required'
      if (!data.alertChannelConfig.to) newErrors.to = 'To address is required'
    }
    if (data.alertChannelType === 'slack-webhook') {
      if (!data.alertChannelConfig.url) newErrors.url = 'Slack webhook URL is required'
    }
    if (Object.keys(newErrors).length > 0) {
      setChannelFormErrors(newErrors)
      return
    }
    setChannelFormErrors({})
    await onCreateChannel()
    setShowCreateForm(false)
    setData(prev => ({ ...prev, alertChannelType: '', alertChannelConfig: {} }))
  }

  const existingChannels = [
    { id: 'ch_1', name: 'Primary Email', type: 'email-smtp', enabled: true },
    { id: 'ch_2', name: 'Slack Alerts', type: 'slack-webhook', enabled: true },
    { id: 'ch_3', name: 'In-App', type: 'in-app-websocket', enabled: true },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Configure Alerts</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Choose how you want to be notified when issues are detected. Select an existing channel or create a new one.
        </p>
      </div>

      {errors.alertChannelId && (
        <div className="text-sm text-destructive" role="alert">{errors.alertChannelId}</div>
      )}

      <div className="space-y-3">
        <h4 className="text-sm font-medium">Existing Channels</h4>
        {existingChannels.map((channel) => (
          <div
            key={channel.id}
            className={cn(
              'flex items-center justify-between p-3 border rounded-lg transition-colors cursor-pointer',
              data.alertChannelId === channel.id
                ? 'border-brand bg-brand/10'
                : 'border-border hover:border-glow-500/50'
            )}
            onClick={() => setData(prev => ({ ...prev, alertChannelId: channel.id }))}
          >
            <div className="flex items-center gap-3">
              <div className="size-9 flex items-center justify-center rounded-lg bg-surface-secondary">
                {channel.type === 'email-smtp' && <Wifi className="size-4" />}
                {channel.type === 'slack-webhook' && <Github className="size-4" />}
                {channel.type === 'in-app-websocket' && <Wifi className="size-4" />}
              </div>
              <div>
                <p className="font-medium">{channel.name}</p>
                <p className="text-sm text-muted-foreground">{channel.type}</p>
              </div>
            </div>
            {data.alertChannelId === channel.id && (
              <Check className="size-4 text-success" aria-hidden />
            )}
          </div>
        ))}
      </div>

      <Separator />

      <div className="space-y-4">
        <h4 className="text-sm font-medium">Or Create a New Channel</h4>
        <Button
          variant={showCreateForm ? 'default' : 'outline'}
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="w-full sm:w-auto"
        >
          {showCreateForm ? 'Cancel' : 'Create New Channel'}
        </Button>

        {showCreateForm && (
          <div className="space-y-4 border border-border rounded-lg p-4 bg-surface-secondary/50">
            <div className="space-y-2">
              <Label>Channel Type *</Label>
              <Select
                value={data.alertChannelType}
                onValueChange={(value) => {
                  setData(prev => ({ ...prev, alertChannelType: value, alertChannelConfig: {} }))
                  setChannelFormErrors({})
                }}
              >
                <SelectTrigger className={channelFormErrors.type ? 'border-destructive' : undefined}>
                  <SelectValue placeholder="Select channel type" />
                </SelectTrigger>
                <SelectContent>
                  {ALERT_CHANNEL_TYPES.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {channelFormErrors.type && <p className="text-sm text-destructive" role="alert">{channelFormErrors.type}</p>}
            </div>

            {data.alertChannelType === 'email-smtp' && (
              <div className="space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="smtpHost">SMTP Host *</Label>
                    <Input
                      id="smtpHost"
                      value={data.alertChannelConfig.host}
                      onChange={(e) => handleConfigChange('host', e.target.value)}
                      placeholder="smtp.example.com"
                      className={channelFormErrors.host ? 'border-destructive' : undefined}
                    />
                    {channelFormErrors.host && <p className="text-sm text-destructive">{channelFormErrors.host}</p>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="smtpPort">Port *</Label>
                    <Input
                      id="smtpPort"
                      type="number"
                      value={data.alertChannelConfig.port}
                      onChange={(e) => handleConfigChange('port', e.target.value)}
                      placeholder="587"
                      className={channelFormErrors.port ? 'border-destructive' : undefined}
                    />
                    {channelFormErrors.port && <p className="text-sm text-destructive">{channelFormErrors.port}</p>}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="smtpUser">Username *</Label>
                    <Input
                      id="smtpUser"
                      value={data.alertChannelConfig.username}
                      onChange={(e) => handleConfigChange('username', e.target.value)}
                      placeholder="user@example.com"
                      className={channelFormErrors.username ? 'border-destructive' : undefined}
                    />
                    {channelFormErrors.username && <p className="text-sm text-destructive">{channelFormErrors.username}</p>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="smtpPass">Password *</Label>
                    <Input
                      id="smtpPass"
                      type="password"
                      value={data.alertChannelConfig.password}
                      onChange={(e) => handleConfigChange('password', e.target.value)}
                      placeholder="••••••••"
                      className={channelFormErrors.password ? 'border-destructive' : undefined}
                    />
                    {channelFormErrors.password && <p className="text-sm text-destructive">{channelFormErrors.password}</p>}
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="smtpFrom">From Address *</Label>
                    <Input
                      id="smtpFrom"
                      type="email"
                      value={data.alertChannelConfig.from}
                      onChange={(e) => handleConfigChange('from', e.target.value)}
                      placeholder="alerts@example.com"
                      className={channelFormErrors.from ? 'border-destructive' : undefined}
                    />
                    {channelFormErrors.from && <p className="text-sm text-destructive">{channelFormErrors.from}</p>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="smtpTo">To Address *</Label>
                    <Input
                      id="smtpTo"
                      type="email"
                      value={data.alertChannelConfig.to}
                      onChange={(e) => handleConfigChange('to', e.target.value)}
                      placeholder="oncall@example.com"
                      className={channelFormErrors.to ? 'border-destructive' : undefined}
                    />
                    {channelFormErrors.to && <p className="text-sm text-destructive">{channelFormErrors.to}</p>}
                  </div>
                </div>
              </div>
            )}

            {data.alertChannelType === 'slack-webhook' && (
              <div className="space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="slackUrl">Webhook URL *</Label>
                  <Input
                    id="slackUrl"
                    type="url"
                    value={data.alertChannelConfig.url}
                    onChange={(e) => handleConfigChange('url', e.target.value)}
                    placeholder="https://hooks.slack.com/services/..."
                    className={channelFormErrors.url ? 'border-destructive' : undefined}
                  />
                  {channelFormErrors.url && <p className="text-sm text-destructive">{channelFormErrors.url}</p>}
                </div>
              </div>
            )}

            {data.alertChannelType === 'in-app-websocket' && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  In-app notifications will appear in the dashboard notification center.
                  No additional configuration required.
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button onClick={handleCreate} disabled={creating}>
                {creating ? (
                  <>
                    <Loader2 className="size-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create Channel'
                )}
              </Button>
              <Button variant="outline" onClick={() => { setShowCreateForm(false); setChannelFormErrors({}) }}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>

      {data.alertChannelId && (
        <Card className="border-success bg-success/5">
          <CardContent className="pt-4">
            <p className="text-sm text-success">
              <Check className="size-4 mr-2 inline" />
              Alert channel selected. The test check will use this channel for notifications.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function TestStep({
  data,
  testResult,
  onPreviewTest,
  onTestCheck,
  previewPending,
  testPending,
  errors,
  createdAppId,
}: {
  data: WizardData
  testResult: 'idle' | 'running' | 'success' | 'error'
  onPreviewTest: () => Promise<void>
  onTestCheck: () => Promise<void>
  previewPending: boolean
  testPending: boolean
  errors: Partial<Record<keyof WizardData, string>>
  createdAppId: string | null
}) {
  const canPreview = data.checkTarget.trim().length > 0
  const canTest = createdAppId && data.checkTarget.trim().length > 0

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">Test & Confirm</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Run a test check to verify your configuration works before adding the app.
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
              <p className="text-muted-foreground">Check Target</p>
              <p className="font-medium truncate max-w-[200px]">{data.checkTarget}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Interval</p>
              <p className="font-medium">{data.checkIntervalSec}s</p>
            </div>
            <div>
              <p className="text-muted-foreground">Timeout</p>
              <p className="font-medium">{data.checkTimeoutSec}s</p>
            </div>
            <div>
              <p className="text-muted-foreground">Alert Channel</p>
              <p className="font-medium">{data.alertChannelId || 'None'}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {!createdAppId ? (
          <>
            <Button
              onClick={onPreviewTest}
              disabled={previewPending || !canPreview}
              className="w-full sm:w-auto"
              size="lg"
            >
              {previewPending ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Running preview check...
                </>
              ) : (
                <>
                  <Wifi className="size-4 mr-2" />
                  Run Preview Check
                </>
              )}
            </Button>
            <p className="text-sm text-muted-foreground">
              This runs a test check without creating the app. The app will be created in the next step.
            </p>
          </>
        ) : (
          <>
            <Button
              onClick={onTestCheck}
              disabled={testPending || !canTest}
              className="w-full sm:w-auto"
              size="lg"
            >
              {testPending ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Running test check...
                </>
              ) : testResult === 'success' ? (
                <>
                  <Check className="size-4 mr-2 text-success" />
                  Test passed — ready to add
                </>
              ) : testResult === 'error' ? (
                <>
                  <AlertCircle className="size-4 mr-2 text-destructive" />
                  Test failed — retry or adjust
                </>
              ) : (
                <>
                  <Wifi className="size-4 mr-2" />
                  Run Test Check
                </>
              )}
            </Button>
            {testResult !== 'idle' && testResult !== 'running' && (
              <p className="text-sm text-muted-foreground">
                {testResult === 'success'
                  ? 'Your check is working correctly. Click "Add App" to start monitoring.'
                  : 'Please verify the URL and network access, then try again.'}
              </p>
            )}
          </>
        )}

        {testResult === 'error' && errors.checkTarget && (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertTriangle className="size-4" />
            <span>{errors.checkTarget}</span>
          </div>
        )}

        {testResult === 'success' && (
          <div className="flex items-center gap-2 text-sm text-success" role="status">
            <Check className="size-4" />
            <span>Test passed. The app is ready to be added with this configuration.</span>
          </div>
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