import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const monitorsRouter = router({
  list: publicProcedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }).optional())
    .query(async ({ input }) => {
      const results = await backend.checkResults.list(input)
      const checks = results.results.map(r => ({
        id: r.checkId,
        name: `Check ${r.checkId.slice(0, 8)}`,
        source: 'system',
        enabled: true,
        lastStatus: r.status,
        lastRun: r.executedAt,
      }))
      return { monitors: checks, count: results.count }
    }),

  detail: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const results = await backend.checkResults.list({ limit: 200 })
      const result = results.results.find(r => r.checkId === input.id)
      if (!result) throw new Error(`Monitor ${input.id} not found`)
      return result
    }),
})
