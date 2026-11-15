'use client'

import { useLiveConnection } from './connection-indicator'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { AlertCircle, WifiOff, RotateCcw } from 'lucide-react'

export function OfflineBanner({ onRetry }: { onRetry?: () => void }) {
  const { status } = useLiveConnection()

  if (status !== 'disconnected') return null

  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn(
        'fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:w-96 z-50',
        'animate-slide-in'
      )}
    >
      <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4 shadow-elevation-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/20">
          <WifiOff className="size-4 text-destructive" aria-hidden />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-destructive">Offline</p>
          <p className="text-sm text-muted-foreground mt-0.5">
            Updates paused. Data may be stale.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="gap-1"
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Retry
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}