import { backend } from '@/server/services/backend'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const POLL_INTERVAL_MS = 10_000

/**
 * Server-sent events bridge for the dashboard live-updates indicator.
 *
 * The backend (nightlamp-api) exposes JSON endpoints only, so this route
 * holds one server-side connection per dashboard tab and re-reads the health
 * snapshot on an interval, forwarding it as SSE. That keeps the browser on a
 * single same-origin stream (no CORS, no backend changes required) and gives
 * the UI a real liveness signal plus round-trip latency.
 */
export async function GET(request: Request) {
  const encoder = new TextEncoder()
  let interval: ReturnType<typeof setInterval> | undefined
  let closed = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => {
        if (closed) return
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
      }

      const tick = async () => {
        const sentAt = new Date().toISOString()
        try {
          const health = await backend.health.get()
          send({ type: 'snapshot', sentAt, health })
        } catch (error) {
          send({
            type: 'error',
            sentAt,
            message: error instanceof Error ? error.message : 'Backend unreachable',
          })
        }
      }

      controller.enqueue(encoder.encode(': connected\n\n'))
      await tick()

      interval = setInterval(tick, POLL_INTERVAL_MS)

      const close = () => {
        if (closed) return
        closed = true
        if (interval) clearInterval(interval)
        try {
          controller.close()
        } catch {
          // Stream already closed by the client.
        }
      }

      request.signal.addEventListener('abort', close)
    },
    cancel() {
      closed = true
      if (interval) clearInterval(interval)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
