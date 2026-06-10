import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const activityRouter = router({
  list: publicProcedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit || 50
      const offset = input?.offset || 0
      const [events, checks, playbook] = await Promise.all([
        backend.events.list({ limit, offset }),
        backend.checkResults.list({ limit: Math.min(limit, 50), offset }),
        backend.playbook.list(),
      ])

      const activity = [
        ...events.events.map(e => ({
          id: `evt-${e.id}`,
          type: e.severity === 'critical' ? 'incident' : 'event',
          summary: e.title,
          timestamp: e.detectedAt,
        })),
        ...checks.results.map(c => ({
          id: `chk-${c.id}`,
          type: 'check' as const,
          summary: c.summary,
          timestamp: c.executedAt,
        })),
        ...playbook.entries.map(p => ({
          id: `pb-${p.id}`,
          type: 'playbook' as const,
          summary: `Playbook: ${p.title}`,
          timestamp: p.lastOccurrenceAt,
        })),
      ]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, limit)

      return { activity, count: activity.length }
    }),
})
