'use client'

import { useEffect, useState } from 'react'
import { ChevronRight, CheckCircle, XCircle, AlertCircle, Loader2, Play, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import type { CheckDefinition, CheckResult } from './types'

interface CheckStepProps {
  check: CheckDefinition
  status: CheckStatus
  result?: CheckResult
  onRun: () => void
  onRetry: () => void
  onCancel?: () => void
  onPrevious: () => void
  onContinue: () => void
  disabled?: boolean
}

type CheckStatus = 'pending' | 'running' | 'success' | 'error'

export function CheckStep({
  check,
  status,
  result,
  onRun,
  onRetry,
  onCancel,
  onPrevious,
  onContinue,
  disabled,
}: CheckStepProps) {
  const [elapsed, setElapsed] = useState(0)
  const [outputLines, setOutputLines] = useState<string[]>([])

  useEffect(() => {
    if (status === 'running') {
      const timer = setInterval(() => setElapsed((e) => e + 1), 1000)
      return () => clearInterval(timer)
    }
    setElapsed(0)
    setOutputLines([])
  }, [status])

  useEffect(() => {
    if (status === 'running' && result?.output) {
      setOutputLines((prev) => [...prev.slice(-99), result.output])
    }
  }, [status, result])

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  if (status === 'pending') {
    return (
      <div className="space-y-6">
        <div className="text-center py-8">
          <CheckCircle className="size-12 text-muted-foreground mx-auto mb-4" aria-hidden />
          <p className="text-lg">Ready to run check</p>
          <p className="text-sm text-muted-foreground mt-1">
            {check.name} — {check.target}
          </p>
        </div>
        <div className="flex justify-center">
          <Button
            size="lg"
            onClick={onRun}
            disabled={disabled}
            className="gap-2"
          >
            <Play className="size-4" aria-hidden />
            Run Check
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'running') {
    return (
      <div className="space-y-6">
        <div className="text-center py-4">
          <Loader2 className="size-12 text-info animate-spin mx-auto mb-4" aria-hidden />
          <p className="text-lg">Running check...</p>
          <p className="text-sm text-muted-foreground mt-1">
            {check.name} — {formatTime(elapsed)} elapsed
          </p>
        </div>

        <Card className="bg-surface-primary border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Live Output</CardTitle>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-64 w-full font-mono text-xs bg-surface-primary rounded p-3">
              <div className="space-y-1 text-left">
                {outputLines.length === 0 && (
                  <div className="text-muted-foreground">Connecting...</div>
                )}
                {outputLines.map((line, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span className="text-muted-foreground shrink-0">{'>'}</span>
                    <span className="flex-1 truncate">{line}</span>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {onCancel && (
          <div className="flex justify-center">
            <Button variant="ghost" onClick={onCancel} disabled={disabled}>
              <X className="size-4 mr-2" aria-hidden />
              Cancel
            </Button>
          </div>
        )}
      </div>
    )
  }

  if (status === 'success') {
    return (
      <div className="space-y-6">
        <div className="text-center py-8">
          <CheckCircle className="size-12 text-success mx-auto mb-4" aria-hidden />
          <p className="text-lg font-semibold text-success">Check passed!</p>
        </div>

        {result && (
          <Card>
            <CardContent className="space-y-3 pt-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <Badge
                    variant={
                      result.status === 'pass'
                        ? 'success'
                        : result.status === 'warn'
                        ? 'warning'
                        : 'destructive'
                    }
                    className="capitalize"
                  >
                    {result.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-muted-foreground">Duration</p>
                  <p className="font-mono font-medium">{result.duration}ms</p>
                </div>
                {result.statusCode && (
                  <div>
                    <p className="text-muted-foreground">Status Code</p>
                    <p className="font-mono font-medium">{result.statusCode}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground">Target</p>
                  <p className="font-mono text-xs truncate max-w-[200px]">{check.target}</p>
                </div>
              </div>

              {result.keyFields && Object.keys(result.keyFields).length > 0 && (
                <div>
                  <p className="text-sm font-medium mb-2">Key Fields</p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {Object.entries(result.keyFields).map(([key, value]) => (
                      <div key={key} className="text-xs font-mono bg-surface-primary p-2 rounded">
                        <span className="text-muted-foreground">{key}:</span>{' '}
                        <span className="truncate block">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {result.output && (
                <div>
                  <p className="text-sm font-medium mb-2">Output</p>
                  <ScrollArea className="h-48 w-full font-mono text-xs bg-surface-primary rounded p-3">
                    <pre className="whitespace-pre-wrap">{result.output}</pre>
                  </ScrollArea>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <div className="flex justify-between pt-4 border-t border-border">
          <Button variant="outline" onClick={onPrevious} disabled={disabled}>
            Previous
          </Button>
          <Button onClick={onContinue} disabled={disabled} className="ml-auto">
            Continue
            <ChevronRight className="size-4 ml-2" aria-hidden />
          </Button>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="space-y-6">
        <div className="text-center py-8">
          <XCircle className="size-12 text-destructive mx-auto mb-4" aria-hidden />
          <p className="text-lg font-semibold text-destructive">Check failed!</p>
        </div>

        {result && (
          <Card className="border-destructive/20">
            <CardContent className="space-y-3 pt-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-muted-foreground">Status</p>
                  <Badge variant="destructive" className="capitalize">
                    {result.status}
                  </Badge>
                </div>
                <div>
                  <p className="text-muted-foreground">Duration</p>
                  <p className="font-mono font-medium">{result.duration}ms</p>
                </div>
                {result.statusCode && (
                  <div>
                    <p className="text-muted-foreground">Status Code</p>
                    <p className="font-mono font-medium">{result.statusCode}</p>
                  </div>
                )}
                <div>
                  <p className="text-muted-foreground">Error</p>
                  <p className="font-mono text-xs truncate max-w-[200px] text-destructive">
                    {result.output}
                  </p>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium mb-2">Suggested actions</p>
                <div className="space-y-2">
                  {[
                    'Check network connectivity',
                    'Verify endpoint URL',
                    'Check firewall/security groups',
                    'Review server logs',
                  ].map((suggestion) => (
                    <label key={suggestion} className="flex items-center gap-2 cursor-pointer">
                      <input type="radio" name="error-suggestion" className="sr-only" />
                      <Card className="flex-1 border-border hover:border-glow-500/60 transition-colors">
                        <CardContent className="py-3 px-4">
                          <span className="text-sm">{suggestion}</span>
                        </CardContent>
                      </Card>
                    </label>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex justify-between pt-4 border-t border-border">
          <Button variant="outline" onClick={onPrevious} disabled={disabled}>
            Previous
          </Button>
          <Button variant="outline" onClick={onRetry} disabled={disabled} className="ml-auto gap-2">
            <Loader2 className="size-4" aria-hidden />
            Run Again
          </Button>
        </div>
      </div>
    )
  }

  return null
}