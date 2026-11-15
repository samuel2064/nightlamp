import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const monitorsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const results = await createBackendClient(ctx.token).checkResults.list(input)
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

  detail: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const results = await createBackendClient(ctx.token).checkResults.list({ limit: 200 })
      const result = results.results.find(r => r.checkId === input.id)
      if (!result) throw new Error(`Monitor ${input.id} not found`)
      return result
    }),
})
