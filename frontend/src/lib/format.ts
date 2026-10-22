// Shared formatting helpers (NOC-195 UX QA round 1)

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
})

const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
})

/** "Oct 21, 2026 · 04:07 UTC" — unambiguous for US customers. */
export function formatUtcTimestamp(ts: string | number | Date | null | undefined): string {
  if (!ts) return '-'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '-'
  return `${dateFmt.format(d)} · ${timeFmt.format(d)} UTC`
}

/** Seconds elapsed since `from`; null when the input is not a valid date. */
export function secondsSince(from: string | number | Date | null | undefined): number | null {
  if (!from) return null
  const d = new Date(from).getTime()
  if (!Number.isFinite(d)) return null
  return Math.max(0, Math.round((Date.now() - d) / 1000))
}

/** "12s ago" / "3m ago" / "1h ago". '-' when the input time is unknown. */
export function relativeTimestamp(from: string | number | Date | null | undefined): string {
  const seconds = secondsSince(from)
  if (seconds === null) return '-'
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return `${hours}h ago`
}

/**
 * Latency label. Never renders a bare `0` (reads as broken) — sub-resolution
 * measurements bucket into `<100ms`; larger values are rounded.
 */
export function formatLatency(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null
  if (ms < 100) return '<100ms'
  if (ms < 60_000) return `${Math.round(ms)}ms`
  return `${(ms / 60_000).toFixed(1)}m`
}
