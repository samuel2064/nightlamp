'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

interface LiveConnection {
  status: ConnectionStatus
  latencyMs: number | null
  lastUpdate: Date | null
  reconnect: () => void
}

const RETRY_WINDOW_MS = 30_000

/**
 * Client half of the /api/stream SSE bridge. EventSource retries on its own;
 * we surface that retry as "reconnecting" and only call it "disconnected" once
 * the stream has been down for longer than RETRY_WINDOW_MS (or the backend
 * reported an error while the stream stayed open).
 */
export function useLiveConnection(): LiveConnection {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [latencyMs, setLatencyMs] = useState<number | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [attempt, setAttempt] = useState(0)

  const downSince = useRef<number | null>(null)

  useEffect(() => {
    const source = new EventSource('/api/stream')
    let disposed = false

    source.onopen = () => {
      if (disposed) return
      downSince.current = null
      setStatus('connected')
    }

    source.onmessage = (event) => {
      if (disposed) return
      try {
        const payload = JSON.parse(event.data) as { type: string; sentAt: string }
        const sentAt = new Date(payload.sentAt).getTime()
        if (Number.isFinite(sentAt)) {
          setLatencyMs(Math.max(0, Date.now() - sentAt))
        }
        setLastUpdate(new Date())
        downSince.current = null
        setStatus(payload.type === 'error' ? 'disconnected' : 'connected')
      } catch {
        // Ignore malformed frames; the next heartbeat will re-sync.
      }
    }

    source.onerror = () => {
      if (disposed) return
      if (downSince.current === null) downSince.current = Date.now()
      setStatus((prev) => (prev === 'connecting' ? 'connecting' : 'reconnecting'))
    }

    const watchdog = setInterval(() => {
      if (disposed) return
      if (downSince.current !== null && Date.now() - downSince.current > RETRY_WINDOW_MS) {
        setStatus('disconnected')
      }
    }, 5_000)

    return () => {
      disposed = true
      clearInterval(watchdog)
      source.close()
    }
  }, [attempt])

  const reconnect = useCallback(() => {
    downSince.current = null
    setStatus('connecting')
    setAttempt((value) => value + 1)
  }, [])

  return { status, latencyMs, lastUpdate, reconnect }
}

const STATUS_META: Record<ConnectionStatus, { label: string; dot: string; text: string }> = {
  connected: {
    label: 'Live',
    dot: 'bg-success animate-pulse-soft',
    text: 'text-success',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-warning animate-pulse',
    text: 'text-warning',
  },
  connecting: {
    label: 'Connecting',
    dot: 'bg-info animate-pulse',
    text: 'text-info',
  },
  disconnected: {
    label: 'Offline',
    dot: 'bg-destructive',
    text: 'text-destructive',
  },
}

function relativeTime(from: Date | null): string {
  if (!from) return 'no updates yet'
  const seconds = Math.max(0, Math.round((Date.now() - from.getTime()) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return `${minutes}m ago`
}

export function ConnectionIndicator({ className }: { className?: string }) {
  const { status, latencyMs, lastUpdate, reconnect } = useLiveConnection()
  const [, forceTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => forceTick((value) => value + 1), 5_000)
    return () => clearInterval(timer)
  }, [])

  const meta = STATUS_META[status]
  const detail =
    status === 'connected'
      ? `Live updates active · Last update: ${relativeTime(lastUpdate)}${
          latencyMs !== null ? ` · Latency: ${latencyMs}ms` : ''
        }`
      : status === 'reconnecting'
        ? 'Reconnecting to live updates…'
        : status === 'connecting'
          ? 'Opening live update stream…'
          : 'Offline · Updates paused'

  const interactive = status === 'disconnected'

  return (
    <button
      type="button"
      onClick={interactive ? reconnect : undefined}
      disabled={!interactive}
      title={interactive ? `${detail} · Click to retry` : detail}
      aria-label={detail}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-border bg-surface-secondary/60 px-3 py-1.5 text-xs font-medium transition-colors',
        'focus-visible:ring-2 focus-visible:ring-[hsl(var(--ring))]',
        meta.text,
        interactive && 'hover:border-glow-500/60 hover:text-glow-400 cursor-pointer',
        !interactive && 'cursor-default',
        className,
      )}
    >
      <span className={cn('size-2 rounded-full', meta.dot)} aria-hidden />
      <span>{meta.label}</span>
      {status === 'connected' && latencyMs !== null && (
        <span className="text-muted-foreground tabular-nums">{latencyMs}ms</span>
      )}
    </button>
  )
}
