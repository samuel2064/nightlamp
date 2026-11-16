'use client'

import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import type { ServerDiagnostic } from './types'

interface AutomationPanelProps {
  diagnostics: ServerDiagnostic[]
  hasExecution: boolean
}

function getStatusIcon(status: ServerDiagnostic['status']) {
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

export function AutomationPanel({
  diagnostics,
  hasExecution,
}: AutomationPanelProps) {
  return (
    <Tabs defaultValue="automation" className="h-full flex flex-col">
      <TabsList className="grid w-full grid-cols-4">
        <TabsTrigger value="automation">Diagnostics</TabsTrigger>
        <TabsTrigger value="context">Context</TabsTrigger>
        <TabsTrigger value="notes">Notes</TabsTrigger>
        <TabsTrigger value="history">History</TabsTrigger>
      </TabsList>

      <TabsContent value="automation" className="flex-1 flex flex-col overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="text-sm font-medium">Server Diagnostics</h3>
        </div>

        <ScrollArea className="flex-1 p-4">
          {!hasExecution ? (
            <div className="text-center py-8 text-muted-foreground">
              <p className="font-medium text-foreground">Diagnostics not available</p>
              <p className="text-sm mt-1">No execution exists yet.</p>
            </div>
          ) : diagnostics.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <p>No diagnostics were reported by the server.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {diagnostics.map((diagnostic) => (
                <Card key={diagnostic.id}>
                  <CardContent className="py-3 px-4">
                    <div className="flex items-center gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center" aria-hidden>
                        {getStatusIcon(diagnostic.status)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium truncate">{diagnostic.title}</p>
                        <p className="text-xs text-muted-foreground truncate">{diagnostic.stepId}</p>
                      </div>
                      <Badge
                        variant={
                          diagnostic.status === 'running'
                            ? 'warning'
                            : diagnostic.status === 'success'
                              ? 'success'
                              : diagnostic.status === 'error'
                                ? 'destructive'
                                : 'secondary'
                        }
                        className="text-[10px] capitalize"
                      >
                        {diagnostic.status}
                      </Badge>
                    </div>
                    {diagnostic.output && (
                      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-primary p-3 font-mono text-xs text-muted-foreground">
                        {diagnostic.output}
                      </pre>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </ScrollArea>
      </TabsContent>

      <TabsContent value="context" className="flex-1 flex flex-col overflow-hidden p-4">
        <h3 className="text-sm font-medium mb-3">Related Context</h3>
        <Card>
          <CardContent className="space-y-2">
            <p className="text-sm text-muted-foreground">
              No additional server context was included with this execution.
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="notes" className="flex-1 flex flex-col overflow-hidden p-4">
        <h3 className="text-sm font-medium mb-3">Annotations</h3>
        <Card className="flex-1">
          <CardContent className="p-0">
            <textarea
              className="w-full h-full bg-transparent border-0 resize-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm font-mono"
              placeholder="No annotation persistence is available in this view."
              spellCheck={false}
              disabled
            />
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="history" className="flex-1 flex flex-col overflow-hidden p-4">
        <h3 className="text-sm font-medium mb-3">Previous Runs</h3>
        <ScrollArea className="flex-1">
          <div className="space-y-2">
            <p className="text-center text-muted-foreground py-8">No execution history is available.</p>
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  )
}
