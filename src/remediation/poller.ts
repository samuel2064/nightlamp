import { evaluatePlaybookEntries } from './engine.js'

let intervalHandle: ReturnType<typeof setInterval> | null = null

export function startPoller(intervalMs?: number): { stop: () => void } {
  if (intervalHandle) {
    stopPoller()
  }

  const interval = intervalMs ?? 60000

  const tick = async () => {
    if (process.env.REMEDIATION_DISABLED === 'true') {
      console.log('[remediation] poller skipped — REMEDIATION_DISABLED=true')
      return
    }

    try {
      const result = await evaluatePlaybookEntries()
      console.log(
        `[remediation] poller: processed=${result.processed} executed=${result.executed} pending=${result.pending} errors=${result.errors.length}`,
      )
      for (const err of result.errors) {
        console.error(`[remediation] error: ${err}`)
      }
    } catch (err) {
      console.error('[remediation] poller error:', err)
    }
  }

  tick()
  intervalHandle = setInterval(tick, interval)

  return {
    stop: () => stopPoller(),
  }
}

export function stopPoller(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
