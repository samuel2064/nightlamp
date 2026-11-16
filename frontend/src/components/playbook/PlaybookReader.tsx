'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { X, Save, ChevronLeft, ChevronRight, CheckCircle2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Sheet, SheetContent } from '@/components/ui/sheet'
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
  CheckResult,
  CheckStatus,
  DiagnosticEntry,
  Playbook,
  PlaybookExecution,
  PlaybookExecutionStatus,
  ServerDiagnostic,
  Step,
} from './types'
import { mapDiagnosticStep, mapDiagnosticToExecutable } from './types'

interface ReaderExecution {
  id: string
  status: PlaybookExecutionStatus
  currentStepIndex: number
  completedIndices: number[]
  skippedIndices: number[]
  answers: Record<string, string[]>
  steps: Step[]
}

interface PlaybookReaderProps {
  playbookId: string
  onExit: () => void
}

function readStepResults(execution: PlaybookExecution | null): Record<string, unknown> {
  if (!execution || typeof execution.stepResults !== 'object' || execution.stepResults === null) return {}
  return execution.stepResults as Record<string, unknown>
}

function toCheckStatus(value: unknown): CheckStatus {
  if (!value || typeof value !== 'object') return 'pending'
  const raw = value as Record<string, unknown>
  if (raw.success === true) return 'success'
  if (raw.success === false) return 'error'
  return 'pending'
}

function toCheckResult(value: unknown): CheckResult | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const status = raw.status === 'pass' || raw.success === true ? 'pass' : raw.status === 'warn' ? 'warn' : 'fail'
  const output = typeof raw.output === 'string'
    ? raw.output
    : raw.output !== undefined
      ? JSON.stringify(raw.output)
      : ''
  const keyFields = raw.keyFields && typeof raw.keyFields === 'object'
    ? Object.fromEntries(Object.entries(raw.keyFields as Record<string, unknown>).map(([key, item]) => [key, String(item)]))
    : undefined
  return {
    status,
    statusCode: typeof raw.statusCode === 'number' ? raw.statusCode : undefined,
    duration: typeof raw.duration === 'number' ? raw.duration : 0,
    output,
    keyFields,
  }
}

function toDiagnostics(execution: PlaybookExecution | null): ServerDiagnostic[] {
  const results = readStepResults(execution)
  if (!execution) return []
  return Object.entries(results).map(([stepId, value]) => {
    const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    return {
      id: `${execution.id}:${stepId}`,
      stepId,
      title: typeof raw.title === 'string' ? raw.title : stepId,
      status: toCheckStatus(value),
      output: typeof raw.output === 'string' ? raw.output : raw.output !== undefined ? JSON.stringify(raw.output) : '',
    }
  })
}

export function PlaybookReader({ playbookId, onExit }: PlaybookReaderProps) {
  const [entry, setEntry] = useState<DiagnosticEntry | null>(null)
  const [execution, setExecution] = useState<ReaderExecution | null>(null)
  const [serverExecution, setServerExecution] = useState<PlaybookExecution | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [runUnavailable, setRunUnavailable] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [mobilePane, setMobilePane] = useState<'navigator' | 'content' | 'panels'>('content')

  const utils = trpc.useUtils()

  const { data: entryData, isLoading: entryLoading, isError: entryError } = trpc.playbook.get.useQuery(
    { id: playbookId },
    { enabled: !!playbookId }
  )

  useEffect(() => {
    if (entryData) {
      setEntry(entryData)
      setLoading((prev) => prev && false)
    }
  }, [entryData])

  useEffect(() => {
    if (entryError) {
      setError('Failed to load playbook')
      setLoading((prev) => prev && false)
    }
  }, [entryError])

  const steps = useMemo<Step[]>(() => {
    if (!entry) return []
    if (entry.steps && entry.steps.length > 0) return entry.steps
    const mapped = mapDiagnosticStep(entry)
    return mapped ? [mapped] : []
  }, [entry])

  const executable = useMemo(() => (entry ? mapDiagnosticToExecutable(entry) : null), [entry])
  const noExecutableDefinition = !executable
  const unavailableReason = runUnavailable
    ?? (noExecutableDefinition
      ? 'This diagnostic has no automated playbook definition yet - there is nothing to execute on the server.'
      : null)

  const playbook = useMemo<Playbook | null>(() => {
    if (!entry) return null
    return { id: entry.id, title: entry.title, steps }
  }, [entry, steps])

  const runPlaybook = trpc.playbook.run.useMutation({
    onSuccess: (created) => {
      setServerExecution(created)
      setRunUnavailable(null)
      setExecution({
        id: created.id,
        status: created.status,
        currentStepIndex: 0,
        completedIndices: [],
        skippedIndices: [],
        answers: {},
        steps,
      })
      toast.success('Playbook started')
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Failed to start playbook'
      if (message.includes('404') || message.toLowerCase().includes('not found')) {
        setRunUnavailable('This diagnostic has no automated playbook definition yet - there is nothing to execute on the server.')
        toast.error('No automated playbook definition for this diagnostic')
        return
      }
      setError(message)
      toast.error('Failed to start playbook')
    },
  })

  const decisionMutation = trpc.playbook.decision.useMutation({
    onSuccess: (updated) => {
      setServerExecution(updated)
      setExecution((prev) => {
        if (!prev) return prev
        const nextIndex = Math.min(prev.currentStepIndex + 1, Math.max(prev.steps.length - 1, 0))
        return {
          ...prev,
          status: updated.status,
          currentStepIndex: nextIndex,
          completedIndices: prev.completedIndices.includes(prev.currentStepIndex)
            ? prev.completedIndices
            : [...prev.completedIndices, prev.currentStepIndex],
        }
      })
      toast.success('Decision recorded')
    },
    onError: (err) => {
      toast.error(`Failed to record decision: ${err.message}`)
    },
  })

  useEffect(() => {
    if (!serverExecution || serverExecution.status !== 'running') return
    const timer = setInterval(async () => {
      try {
        const updated = await utils.playbook.getExecution.fetch({ executionId: serverExecution.id })
        setServerExecution(updated)
        setExecution((prev) => (prev ? { ...prev, status: updated.status } : prev))
      } catch {
        setServerExecution((prev) => (prev ? { ...prev, status: 'failed' } : prev))
      }
    }, 2000)
    return () => clearInterval(timer)
  }, [serverExecution, utils])

  const handleRunPlaybook = useCallback(() => {
    if (runUnavailable || noExecutableDefinition) return
    runPlaybook.mutate({ id: playbookId, context: { source: 'nightlamp-ui' } })
  }, [runPlaybook, playbookId, runUnavailable, noExecutableDefinition])

  const handleDecision = useCallback((stepId: string, answer: string[], skipped = false) => {
    if (!execution) return
    decisionMutation.mutate({
      executionId: execution.id,
      decision: JSON.stringify({ stepId, answer, skipped }),
    })
    setExecution((prev) => {
      if (!prev) return prev
      const nextIndex = Math.min(prev.currentStepIndex + 1, Math.max(prev.steps.length - 1, 0))
      return {
        ...prev,
        currentStepIndex: nextIndex,
        completedIndices: prev.completedIndices.includes(prev.currentStepIndex)
          ? prev.completedIndices
          : [...prev.completedIndices, prev.currentStepIndex],
        skippedIndices: skipped && !prev.skippedIndices.includes(prev.currentStepIndex)
          ? [...prev.skippedIndices, prev.currentStepIndex]
          : prev.skippedIndices,
        answers: { ...prev.answers, [stepId]: answer },
      }
    })
  }, [decisionMutation, execution])

  const handlePrevious = useCallback(() => {
    setExecution((prev) => (prev ? { ...prev, currentStepIndex: Math.max(0, prev.currentStepIndex - 1) } : prev))
  }, [])

  const handleRunCheck = useCallback(() => {
    toast.error('This release does not run individual checks from the browser - the result comes from the playbook execution on the server.')
  }, [])

  const handleMarkResolved = useCallback(() => {
    if (!execution) return
    const stepId = execution.steps[execution.currentStepIndex]?.id
    decisionMutation.mutate({
      executionId: execution.id,
      decision: JSON.stringify({ stepId, action: 'mark_resolved' }),
    })
  }, [decisionMutation, execution])

  const handleRefresh = useCallback(() => {
    if (!serverExecution) return
    utils.playbook.getExecution.invalidate({ executionId: serverExecution.id })
  }, [serverExecution, utils])

  const currentStep = execution ? execution.steps[execution.currentStepIndex] : undefined
  const isComplete = execution?.status === 'completed' || (currentStep?.type === 'RESOLUTION' && !!execution)
  const diagnostics = useMemo(() => toDiagnostics(serverExecution), [serverExecution])
  const stepResults = readStepResults(serverExecution)
  const checkStatus = currentStep?.type === 'CHECK'
    ? toCheckStatus(currentStep.id in stepResults ? stepResults[currentStep.id] : undefined)
    : 'pending'
  const checkResult = currentStep?.type === 'CHECK'
    ? toCheckResult(currentStep.id in stepResults ? stepResults[currentStep.id] : undefined)
    : undefined

  if (loading || entryLoading) {
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

  if (!entry) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading playbook...</p>
      </div>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background">
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
          {execution ? (
            <div className="flex items-center gap-4 text-sm">
              <span>Step {execution.currentStepIndex + 1} of {execution.steps.length}</span>
              <span className="text-muted-foreground">•</span>
              <Badge variant="outline">{execution.status}</Badge>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge variant="outline">{entry.failureType}</Badge>
              <span>{entry.title}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-4">
          <ConnectionIndicator />
          {!execution && (
            <Button
              onClick={handleRunPlaybook}
              disabled={runPlaybook.isPending || !!unavailableReason}
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
            <Button variant="outline" size="sm" onClick={handleRefresh} className="gap-2">
              <RefreshCw className="size-4" aria-hidden />
              Refresh
            </Button>
          )}
          {execution && (
            <Button variant="outline" size="sm" onClick={onExit} className="gap-2">
              <Save className="size-4" aria-hidden />
              Exit & Save
            </Button>
          )}
        </div>
      </header>

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

      <div className="flex-1 flex overflow-hidden">
        <Sheet open={sheetOpen && mobilePane === 'navigator'} onOpenChange={(open) => { setSheetOpen(open); if (!open) setMobilePane('content') }}>
          <SheetContent side="left" className="w-64 h-full max-w-[256px] p-0">
            {execution && playbook && (
              <StepNavigator
                playbook={playbook}
                currentIndex={execution.currentStepIndex}
                completedIndices={execution.completedIndices}
                skippedIndices={execution.skippedIndices}
                onNavigate={(index) => {
                  setExecution((prev) => (prev ? { ...prev, currentStepIndex: index } : prev))
                  setSheetOpen(false)
                  setMobilePane('content')
                }}
                onExitSave={onExit}
              />
            )}
          </SheetContent>
        </Sheet>

        <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-surface-secondary/40">
          {execution && playbook && (
            <StepNavigator
              playbook={playbook}
              currentIndex={execution.currentStepIndex}
              completedIndices={execution.completedIndices}
              skippedIndices={execution.skippedIndices}
              onNavigate={(index) => setExecution((prev) => (prev ? { ...prev, currentStepIndex: index } : prev))}
              onExitSave={onExit}
            />
          )}
        </aside>

        <main className="flex-1 flex flex-col overflow-hidden">
          {currentStep && (
            <div className="flex-1 overflow-y-auto p-4 md:p-6">
              <StepHeader
                stepNumber={execution ? execution.currentStepIndex + 1 : 1}
                totalSteps={execution ? execution.steps.length : 0}
                title={currentStep.title}
                type={currentStep.type}
              />
              {currentStep.type === 'QUESTION' && (
                <QuestionStep
                  question={currentStep.question}
                  previousValues={execution?.answers[currentStep.id]}
                  disabled={isComplete}
                  onAnswer={(values) => {
                    if (values[0] === '__PREVIOUS__') {
                      handlePrevious()
                    } else {
                      handleDecision(currentStep.id, values)
                    }
                  }}
                />
              )}
              {currentStep.type === 'CHECK' && (
                <CheckStep
                  check={currentStep.check}
                  status={checkStatus}
                  result={checkResult}
                  disabled={isComplete}
                  onRun={handleRunCheck}
                  onRetry={handleRunCheck}
                  onPrevious={handlePrevious}
                  onContinue={() => handleDecision(currentStep.id, [])}
                />
              )}
              {currentStep.type === 'ACTION' && (
                <ActionStep
                  action={currentStep.action}
                  disabled={isComplete}
                  onComplete={() => handleDecision(currentStep.id, ['completed'])}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep.type === 'INFO' && (
                <InfoStep
                  info={currentStep.info}
                  disabled={isComplete}
                  onContinue={() => handleDecision(currentStep.id, [])}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep.type === 'BRANCH' && (
                <BranchStep
                  branch={currentStep.branch}
                  disabled={isComplete}
                  onContinue={() => handleDecision(currentStep.id, [])}
                  onPrevious={handlePrevious}
                />
              )}
              {currentStep.type === 'RESOLUTION' && (
                <ResolutionStep
                  resolution={currentStep.resolution}
                  disabled={isComplete}
                  onExport={() => {}}
                  onMarkResolved={handleMarkResolved}
                  onPostMortem={() => {}}
                  onClose={onExit}
                />
              )}
            </div>
          )}

          {!currentStep && !execution && (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <Card className="w-full max-w-md">
                <CardContent className="py-8">
                  <div className="space-y-4">
                    <div>
                      <Badge variant="outline" className="mb-2">{entry.failureType}</Badge>
                      <h3 className="text-lg font-semibold">{entry.title}</h3>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      This playbook will guide you through diagnosing and resolving the issue.
                    </p>
                    {unavailableReason ? (
                      <Alert variant="destructive">
                        <AlertDescription>{unavailableReason}</AlertDescription>
                      </Alert>
                    ) : (
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
                    )}
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

        <Sheet open={sheetOpen && mobilePane === 'panels'} onOpenChange={(open) => { setSheetOpen(open); if (!open) setMobilePane('content') }}>
          <SheetContent side="right" className="w-80 h-full max-w-[320px] p-0">
            <AutomationPanel diagnostics={diagnostics} hasExecution={!!serverExecution} />
          </SheetContent>
        </Sheet>

        <aside className="hidden md:flex w-80 shrink-0 border-l border-border bg-surface-secondary/40">
          <AutomationPanel diagnostics={diagnostics} hasExecution={!!serverExecution} />
        </aside>
      </div>

      <div className="md:hidden border-t border-border bg-surface-primary p-3">
        <div className="flex justify-between gap-2">
          <Button variant="outline" onClick={handlePrevious} disabled={!execution || execution.currentStepIndex === 0} className="flex-1">
            Previous
          </Button>
          {currentStep?.type === 'CHECK' && !isComplete && (
            <Button onClick={handleRunCheck} className="flex-1 gap-2">
              <ChevronRight className="size-4" aria-hidden />
              Run Check
            </Button>
          )}
          {currentStep?.type === 'ACTION' && !isComplete && (
            <Button onClick={() => handleDecision(currentStep.id, ['completed'])} className="flex-1 gap-2">
              Mark Complete
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          )}
          {(currentStep?.type === 'QUESTION' || currentStep?.type === 'INFO' || currentStep?.type === 'BRANCH') && !isComplete && (
            <Button onClick={() => handleDecision(currentStep.id, [])} className="flex-1 gap-2">
              Continue
              <ChevronRight className="size-4" aria-hidden />
            </Button>
          )}
          {currentStep?.type === 'RESOLUTION' && !isComplete && (
            <Button onClick={handleMarkResolved} className="flex-1 gap-2">
              Mark Resolved
              <CheckCircle2 className="size-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
