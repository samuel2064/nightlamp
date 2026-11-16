'use client'

import { useState } from 'react'
import { ChevronRight, ChevronDown, CheckCircle2, XCircle, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'
import type { BranchDefinition } from './types'

interface BranchStepProps {
  branch: BranchDefinition
  onContinue: () => void
  onPrevious: () => void
  disabled?: boolean
}

export function BranchStep({
  branch,
  onContinue,
  onPrevious,
  disabled,
}: BranchStepProps) {
  const [showSkipped, setShowSkipped] = useState(false)
  const { condition, result, truePath, falsePath, skippedSteps } = branch

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-4 space-y-4">
          <div>
            <p className="text-sm font-medium text-muted-foreground mb-1">Evaluating</p>
            <p className="text-lg">{condition}</p>
          </div>

          <div className="flex items-center gap-4 p-4 bg-surface-tertiary/50 rounded-lg">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Previous answer:</span>
              <Badge variant={result ? 'success' : 'warning'} className="text-sm">
                {result ? 'TRUE' : 'FALSE'}
              </Badge>
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Following</span>
            <Badge variant="outline" className={result ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/20'}>
              {result ? 'YES' : 'NO'} branch
            </Badge>
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            <span className="font-medium">{result ? truePath : falsePath}</span>
          </div>

          {skippedSteps.length > 0 && (
            <div className="border-t border-border pt-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium">
                  Skipped steps ({skippedSteps.length})
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSkipped(!showSkipped)}
                  disabled={disabled}
                  className="gap-1"
                >
                  {showSkipped ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                  View Skipped Steps
                </Button>
              </div>

              <Collapsible open={showSkipped}>
                <CollapsibleContent className="space-y-2 pt-2">
                  {skippedSteps.map((step, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <XCircle className="size-4" aria-hidden />
                      <span>{step}</span>
                    </div>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between pt-4 border-t border-border">
        <Button variant="outline" onClick={onPrevious} disabled={disabled}>
          Previous
        </Button>
        <Button onClick={onContinue} disabled={disabled} className="ml-auto gap-2">
          Continue
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}