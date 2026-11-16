'use client'

import { useState } from 'react'
import { Loader2, CheckCircle2, XCircle, Clock, Pause, Play, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import type { CheckDefinition, CheckResult, ActiveUser } from './types'

interface RunningCheck {
  check: CheckDefinition
  status: 'queued' | 'running' | 'success' | 'error'
  result?: CheckResult
  startTime?: number
}

interface AutomationPanelProps {
  runningChecks: RunningCheck[]
  recentOutput: string[]
  activeUsers: ActiveUser[]
  onPauseAll: () => void
  onClearOutput: () => void
}

function getStatusIcon(status: RunningCheck['status']) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-4 animate-spin text-info" aria-hidden />
    case 'success':
      return <CheckCircle2 className="size-4 text-success" aria-hidden />
    case 'error':
      return <XCircle className="size-4 text-destructive" aria-hidden />
    default:
      return <Clock className="size-4 text-warning" aria-hidden />
  }
}

function formatElapsed(startTime: number) {
  const elapsed = Math.floor((Date.now() - startTime) / 1000)
  const mins = Math.floor(elapsed / 60)
  const secs = elapsed % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function AutomationPanel({
  runningChecks,
  recentOutput,
  activeUsers,
  onPauseAll,
  onClearOutput,
}: AutomationPanelProps) {
  const [paused, setPaused] = useState(false)

  return (
    <Tabs defaultValue="automation" className="h-full flex flex-col">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="automation">Auto</TabsTrigger>
        <TabsTrigger value="context">Context</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>

      <TabsContent value="automation" className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <CardTitle className="text-sm font-medium">Running Checks</CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { setPaused(!paused); onPauseAll() }}
              className={paused ? 'bg-warning/10 text-warning' : ''}
              aria-pressed={paused}
            >
              {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            </Button>
          </div>
        </div>

        <ScrollArea className="flex-1 p-4">
          {runningChecks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No checks running</p>
              <p className="text-sm mt-1">Start a check from the step content</p>
            </div>
          ) : (
            <div className="space-y-3">
              {runningChecks.map((rc, i) => (
                <Card key={i} className="hover:border-glow-500/60 transition-colors">
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden>
                        {getStatusIcon(rc.status)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{rc.check.name}</p>
                        <p className="text-xs text-muted-foreground truncate">{rc.check.target}</p>
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {rc.status === 'running' && rc.startTime && (
                          <span className="text-info font-mono">{formatElapsed(rc.startTime)}</span>
                        )}
                        <Badge
                          variant={
                            rc.status === 'running'
                              ? 'warning'
                              : rc.status === 'success'
                              ? 'success'
                              : rc.status === 'error'
                              ? 'destructive'
                              : 'secondary'
                          }
                          className="text-[10px] capitalize"
                        >
                          {rc.status}
                        </Badge>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </ScrollArea>

        <div className="border-t border-border p-4">
          <CardTitle className="text-sm font-medium mb-3">Recent Output</CardTitle>
          <ScrollArea className="h-48 w-full font-mono text-xs bg-surface-primary rounded p-3">
            <div className="space-y-1 text-left">
              {recentOutput.length === 0 && (
                <div className="text-muted-foreground">No output yet</div>
              )}
              {recentOutput.map((line, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-muted-foreground shrink-0">{'>'}</span>
                  <span className="flex-1 truncate">{line}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={onClearOutput}>
              <Trash2 className="size-3 mr-1" aria-hidden />
              Clear
            </Button>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="context" className="flex-1 flex flex-col overflow-hidden p-4">
        <CardTitle className="text-sm font-medium mb-3">Related Context</CardTitle>
        <div className="space-y-4 flex-1 overflow-y-auto">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Related Metrics</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">Mini sparklines for related services</p>
              <p className="text-sm text-muted-foreground">Recent Incidents (24h): clickable links</p>
              <p className="text-sm text-muted-foreground">Similar Playbook Runs: success rates</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Related Logs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" className="w-full justify-start gap-2" size="sm">
                View Last 100 Lines
              </Button>
              <Button variant="outline" className="w-full justify-start gap-2" size="sm">
                Filter by service, level, time
              </Button>
            </CardContent>
          </Card>

          <Button variant="outline" className="w-full justify-start gap-2" size="sm">
            Open in Log Explorer
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="notes" className="flex-1 flex flex-col overflow-hidden p-4">
        <CardTitle className="text-sm font-medium mb-3">Annotations</CardTitle>
        <Card className="flex-1">
          <CardContent className="p-0">
            <textarea
              className="w-full h-full p-4 bg-transparent border-0 resize-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm font-mono"
              placeholder="Add notes... (auto-saves to localStorage + server)"
              spellCheck={false}
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="history" className="flex-1 flex flex-col overflow-hidden p-4">
        <CardTitle className="text-sm font-medium mb-3">Previous Runs</CardTitle>
        <ScrollArea className="flex-1">
          <div className="space-y-2">
            <p className="text-center text-muted-foreground py-8">No previous runs</p>
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}