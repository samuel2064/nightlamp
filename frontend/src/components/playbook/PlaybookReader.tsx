'use client'

import { useState, useEffect, useCallback } from 'react'
import { X, Save, ChevronLeft, ChevronRight, CheckCircle2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { ConnectionIndicator } from '@/components/dashboard/connection-indicator'
import { StepNavigator } from './StepNavigator'
import { StepHeader } from './StepHeader'
import { QuestionStep } from './QuestionStep'
import { CheckStep } from './CheckStep'
import { ActionStep } from './ActionStep'
import { InfoStep } from './InfoStep'
import { BranchStep } from './BranchStep'
import { ResolutionStep } from './ResolutionStep'
import { AutomationPanel } from './AutomationPanel'
import { trpc } from '@/lib/trpc'
import { toast } from 'sonner'
import type {
  DiagnosticEntry,
  PlaybookExecution,
  ActiveUser,
  RunningCheck,
  RightPanelTab,
  CheckStatus,
  CheckResult,
} from './types'
import { mapDiagnosticToExecutable } from './types'

interface PlaybookReaderProps {
  playbookId: string
  onExit: () => void
}

export function PlaybookReader({ playbookId, onExit }: PlaybookReaderProps) {
  const [execution, setExecution] = useState<PlaybookExecution | null>(null)
  const [playbookEntry, setPlaybookEntry] = useState<DiagnosticEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sseConnected, setSseConnected] = useState(false)
  const [activeUsers, setActiveUsers] = useState<ActiveUser[]>([])
  const [runningChecks, setRunningChecks] = useState<RunningCheck[]>([])
  const [recentOutput, setRecentOutput] = useState<string[]>([])
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('automation')
  const [mobilePane, setMobilePane] = useState<'navigator' | 'content' | 'panels'>('content')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [polling, setPolling] = useState(false)

  const utils = trpc.useUtils()

  // Fetch playbook entry on mount
  const { data: entryData, isLoading: entryLoading, isError: entryError } = trpc.playbook.get.useQuery(
    { id: playbookId },
    { enabled: !!playbookId }
  )

  useEffect(() => {
    if (entryData) {
      setPlaybookEntry(entryData)
      setLoading((prev) => prev && false)
    }
  }, [entryData])

  useEffect(() => {
    if (entryError) {
      setError('Failed to load playbook')
      setLoading((prev) => prev && false)
    }
  }, [entryError])

  // Simulate SSE connection (replace with real SSE when backend is ready)
  useEffect(() => {
    if (!execution?.id) return
    setSseConnected((prev) => prev || true)
  }, [execution?.id])

  // Poll execution state when running
  useEffect(() => {
    if (!execution?.id || execution.status !== 'running' || polling) return

    setPolling((prev) => prev || true)
    const interval = setInterval(async () => {
      try {
        const updated = await utils.playbook.getExecution.fetch({ executionId: execution.id })
        setExecution(updated)
        if (updated.status !== 'running') {
          setPolling((prev) => prev && false)
        }
      } catch {
        setPolling((prev) => prev && false)
      }
    }, 2000)

    return () => {
      clearInterval(interval)
      setPolling((prev) => prev && false)
    }
  }, [execution?.id, execution?.status, utils])

  const runPlaybook = trpc.playbook.run.useMutation({
    onSuccess: (newExecution) => {
      setExecution(newExecution)
      toast.success('Playbook started')
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to start playbook')
      toast.error('Failed to start playbook')
    },
  })

  const decisionMutation = trpc.playbook.decision.useMutation({
    onMutate: async ({ executionId, stepId, answer, skipped }) => {
      await utils.playbook.getExecution.cancel({ executionId })
      const prev = utils.playbook.getExecution.getData({ executionId })
      if (prev) {
        const nextIndex = Math.min(prev.currentStepIndex + 1, prev.playbook.steps.length - 1)
        const newCompleted = skipped
          ? [...prev.completedIndices, prev.currentStepIndex]
          : [...prev.completedIndices, prev.currentStepIndex]
        const newSkipped = skipped ? [...prev.skippedIndices, prev.currentStepIndex] : prev.skippedIndices
        utils.playbook.getExecution.setData({ executionId }, {
          ...prev,
          currentStepIndex: skipped ? nextIndex : (prev.currentStepIndex < prev.playbook.steps.length - 1 ? nextIndex : prev.currentStepIndex),
          completedIndices: newCompleted,
          skippedIndices: newSkipped,
          answers: { ...prev.answers, [stepId]: answer },
          updatedAt: new Date().toISOString(),
        })
      }
      return { prev }
    },
    onSuccess: () => {
      toast.success('Decision recorded')
    },
    onError: (err, _variables, context) => {
      if (context?.prev) {
        utils.playbook.getExecution.setData({ executionId: execution?.id ?? '' }, context.prev)
      }
      toast.error(`Failed to record decision: ${err.message}`)
    },
    onSettled: () => {
      if (execution?.id) {
        utils.playbook.getExecution.invalidate({ executionId: execution.id })
      }
    },
  })

  const handleRunPlaybook = () => {
    runPlaybook.mutate({ id: playbookId })
  }

  const handleDecision = useCallback(async (stepId: string, answer: string[], skipped = false) => {
    if (!execution) return
    decisionMutation.mutate({ executionId: execution.id, stepId, answer, skipped })
  }, [execution, decisionMutation])

  const handleRunCheck = useCallback((checkIndex: number) => {
    if (!execution) return

    const step = execution.playbook.steps[execution.currentStepIndex]
    if (step.check) {
      const newRunningCheck: RunningCheck = {
        check: step.check,
        status: 'running',
        startTime: Date.now(),
      }
      setRunningChecks((prev) => [...prev, newRunningCheck])

      // Simulate check execution (replace with real check execution when backend supports it)
      setTimeout(() => {
        setRunningChecks((prev) =>
          prev.map((rc, i) =>
            i === checkIndex
              ? {
                  ...rc,
                  status: 'success',
                  result: {
                    status: 'pass',
                    statusCode: 200,
                    duration: 123,
                    output: 'GET /health\n200 OK (12ms)\nParsing JSON...\nCheck passed!',
                    keyFields: { status: 'healthy', uptime: '99.9%' },
                  },
                }
              : rc
          )
        )
        setRecentOutput((prev) => [
          ...prev,
          '> Connecting...',
          '> TLS handshake OK',
          '> GET /health',
          '> 200 OK (12ms)',
          '> Parsing JSON...',
          '> Check passed!',
        ].slice(-100))
      }, 2000)
    }
  }, [execution])

  const handleExitSave = () => {
    onExit()
  }

  const handlePrevious = () => {
    if (!execution) return
    setExecution((prev) =>
      prev
        ? {
            ...prev,
            currentStepIndex: Math.max(0, prev.currentStepIndex - 1),
          }
        : prev
    )
  }

  const handleContinue = () => {
    if (!execution) return
    const currentStep = execution.playbook.steps[execution.currentStepIndex]
    handleDecision(currentStep.id, execution.answers[currentStep.id] || [])
  }

  const handleRunCheckFromStep = () => {
    if (!execution) return
    const currentStep = execution.playbook.steps[execution.currentStepIndex]
    if (currentStep.type === 'CHECK') {
      handleRunCheck(execution.currentStepIndex)
    }
  }

  const handleCompleteAction = () => {
    if (!execution) return
    const currentStep = execution.playbook.steps[execution.currentStepIndex]
    handleDecision(currentStep.id, ['completed'])
  }

  const handleRetryCheck = () => {
    if (!execution) return
    handleRunCheck(execution.currentStepIndex)
  }

  const handleSkipBranch = () => {
    if (!execution) return
    const currentStep = execution.playbook.steps[execution.currentStepIndex]
    handleDecision(currentStep.id, [], true)
  }

  const handleMarkResolved = () => {
    if (!execution) return
    setExecution((prev) =>
      prev ? { ...prev, status: 'completed' } : prev
    )
  }

  const handleRefresh = () => {
    if (!execution?.id) return
    utils.playbook.getExecution.invalidate({ executionId: execution.id })
  }

  const isInitialLoading = loading || entryLoading

  if (isInitialLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    )
  }

  if (error && !execution) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (entryError && !execution) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Alert variant="destructive">
          <AlertDescription>Failed to load playbook</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (!playbookEntry) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading playbook...</p>
      </div>
    )
  }

  const currentStep = execution?.playbook.steps[execution?.currentStepIndex || 0]
  const StepComponent = currentStep ? STEP_COMPONENTS[currentStep.type] : null
  const isComplete = execution?.status === 'completed' || (execution && execution.currentStepIndex >= execution.playbook.steps.length - 1 && currentStep?.type === 'RESOLUTION')
  const canRun = !execution || execution.status !== 'running'

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Top Bar */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-primary/80 px-4 backdrop-blur">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={onExit} aria-label="Exit playbook">
            <X className="size-5" />
          </Button>
          <div className="flex size-7 items-center justify-center rounded-full bg-glow-500">
            <span className="text-xs font-bold text-nightlamp-950">N</span>
          </div>
          <span className="font-semibold tracking-tight">Nightlamp</span>
        </div>

        <div className="flex-1 flex items-center justify-center">
          {execution && (
            <div className="flex items-center gap-4 text-sm">
              <span>Step {execution.currentStepIndex + 1} of {execution.playbook.steps.length}</span>
              <span className="text-muted-foreground">•</span>
              <span className="text-muted-foreground">~{Math.ceil((execution.playbook.steps.length - execution.currentStepIndex) * 0.75)} min left</span>
            </div>
          )}
          {!execution && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline">{playbookEntry.failureType}</Badge>
              <span>{playbookEntry.title}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          <ConnectionIndicator />
          {!execution && canRun && (
            <Button
              onClick={handleRunPlaybook}
              disabled={runPlaybook.isPending}
              className="gap-2"
            >
              {runPlaybook.isPending ? (
                <>
                  <RefreshCw className="size-4 mr-2 animate-spin" aria-hidden />
                  Starting...
                </>
              ) : (
                <>
                  <RefreshCw className="size-4 mr-2" aria-hidden />
                  Run Playbook
                </>
              )}
            </Button>
          )}
          {execution && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleExitSave}
              disabled={
                execution?.playbook.steps[execution.currentStepIndex]?.type === 'CHECK' &&
                runningChecks.some((rc) => rc.status === 'running')
              }
            >
              <Save className="size-4 mr-2" aria-hidden />
              Exit & Save
            </Button>
          )}
        </div>
      </header>

      {/* Mobile bottom navigation */}
      <div className="md:hidden border-t border-border bg-surface-primary">
        <div className="flex h-12 items-center justify-around px-2">
          <Button
            variant={mobilePane === 'navigator' ? 'default' : 'ghost'}
            size="icon"
            onClick={() => { setMobilePane('navigator'); setSheetOpen(true) }}
            aria-label="Step Navigator"
          >
            <ChevronLeft className="size-5" />
          </Button>
          <Button
            variant={mobilePane === 'content' ? 'default' : 'ghost'}
            size="icon"
            onClick={() => setMobilePane('content')}
            aria-label="Step Content"
          >
            <span className="text-xs">Step</span>
          </Button>
          <Button
            variant={mobilePane === 'panels' ? 'default' : 'ghost'}
            size="icon"
            onClick={() => { setMobilePane('panels'); setSheetOpen(true) }}
            aria-label="Context Panels"
          >
            <span className="text-xs">Panels</span>
          </Button>
        </div>
      </div>

      {/* Main three-pane layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Pane - Step Navigator */}
        <Sheet open={sheetOpen && mobilePane === 'navigator'} onOpenChange={(open) => { setSheetOpen(open); if (!open) setMobilePane('content') }}>
          <SheetContent side="left" className="w-64 h-full max-w-[256px] p-0">
            {execution && (
              <StepNavigator
                playbook={execution.playbook}
                currentIndex={execution.currentStepIndex}
                completedIndices={execution.completedIndices}
                skippedIndices={execution.skippedIndices}
                onNavigate={(index) => {
                  setExecution((prev) => prev ? { ...prev, currentStepIndex: index } : prev)
                  setSheetOpen(false)
                  setMobilePane('content')
                }}
                onExitSave={handleExitSave}
              />
            )}
          </SheetContent>
        </Sheet>

        <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-surface-secondary/40">
          {execution && (
            <StepNavigator
              playbook={execution.playbook}
              currentIndex={execution.currentStepIndex}
              completedIndices={execution.completedIndices}
              skippedIndices={execution.skippedIndices}
              onNavigate={(index) => setExecution((prev) => prev ? { ...prev, currentStepIndex: index } : prev)}
              onExitSave={handleExitSave}
            />
          )}
        </aside>

        {/* Center Pane - Step Content */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {currentStep && StepComponent && (
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              <StepHeader
                stepNumber={execution?.currentStepIndex + 1 || 1}
                totalSteps={execution?.playbook.steps.length || 0}
                title={currentStep.title}
                type={currentStep.type}
              />
              <StepComponent
                {...currentStep}
                onAnswer={(values: string[]) => {
                  if (values[0] === '__PREVIOUS__') {
                    handlePrevious()
                  } else {
                    handleDecision(currentStep.id, values)
                  }
                }}
                onRun={handleRunCheckFromStep}
                onRetry={handleRetryCheck}
                onCancel={() => {}}
                onPrevious={handlePrevious}
                onContinue={handleContinue}
                onComplete={handleCompleteAction}
                onRunAgain={handleRetryCheck}
                onExport={() => {}}
                onMarkResolved={handleMarkResolved}
                onPostMortem={() => {}}
                onClose={onExit}
                disabled={isComplete}
              />
            </div>
          )}
          {!currentStep && !execution && (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <Card className="w-full max-w-md">
                <CardContent className="py-8">
                  <div className="space-y-4">
                    <div>
                      <Badge variant="outline" className="mb-2">{playbookEntry.failureType}</Badge>
                      <h3 className="text-lg font-semibold">{playbookEntry.title}</h3>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      This playbook will guide you through diagnosing and resolving the issue.
                    </p>
                    <Button
                      onClick={handleRunPlaybook}
                      disabled={runPlaybook.isPending}
                      className="w-full gap-2"
                      size="lg"
                    >
                      {runPlaybook.isPending ? (
                        <>
                          <RefreshCw className="size-4 mr-2 animate-spin" aria-hidden />
                          Starting...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="size-4 mr-2" aria-hidden />
                          Run Playbook
                        </>
                      )}
                    </Button>
                    {error && (
                      <Alert variant="destructive" className="mt-4">
                        <AlertDescription>{error}</AlertDescription>
                      </Alert>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          {!currentStep && execution && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground">Select a step to view</p>
            </div>
          )}
        </main>

        {/* Right Pane - Context Panels */}
        <Sheet open={sheetOpen && mobilePane === 'panels'} onOpenChange={(open) => { setSheetOpen(open); if (!open) setMobilePane('content') }}>
          <SheetContent side="right" className="w-80 h-full max-w-[320px] p-0">
            {execution && (
              <AutomationPanel
                runningChecks={runningChecks}
                recentOutput={recentOutput}
                activeUsers={activeUsers}
                onPauseAll={() => setRunningChecks((prev) => prev.map((rc) => ({ ...rc, status: 'queued' })))}
                onClearOutput={() => setRecentOutput([])}
              />
            )}
          </SheetContent>
        </Sheet>

        <aside className="hidden md:flex w-80 shrink-0 border-l border-border bg-surface-secondary/40">
          {execution && (
            <AutomationPanel
              runningChecks={runningChecks}
              recentOutput={recentOutput}
              activeUsers={activeUsers}
              onPauseAll={() => setRunningChecks((prev) => prev.map((rc) => ({ ...rc, status: 'queued' })))}
              onClearOutput={() => setRecentOutput([])}
            />
          )}
        </aside>
      </div>

      {/* Mobile sticky footer for step navigation */}
      <div className="md:hidden border-t border-border bg-surface-primary p-3">
        <div className="flex justify-between gap-2">
          <Button variant="outline" onClick={handlePrevious} disabled={!execution || execution.currentStepIndex === 0} className="flex-1">
            Previous
          </Button>
          {currentStep?.type === 'CHECK' && !isComplete && (
            <Button onClick={handleRunCheckFromStep} disabled={runningChecks.some((rc) => rc.status === 'running')} className="flex-1 gap-2">
              <ChevronRight className="size-4" aria-hidden />
              Run Check
            </Button>
          )}
          {currentStep?.type === 'ACTION' && !isComplete && (
            <Button onClick={handleCompleteAction} disabled={true} className="flex-1 gap-2">
              Mark Complete
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          )}
          {(currentStep?.type === 'QUESTION' || currentStep?.type === 'INFO' || currentStep?.type === 'BRANCH') && !isComplete && (
            <Button onClick={handleContinue} disabled={true} className="flex-1 gap-2">
              Continue
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          )}
          {currentStep?.type === 'RESOLUTION' && !isComplete && (
            <Button onClick={handleMarkResolved} disabled={true} className="flex-1 gap-2">
              Mark Resolved
              <CheckCircle2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}