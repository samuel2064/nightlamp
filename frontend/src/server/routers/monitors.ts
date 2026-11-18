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

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      source: z.string().min(1),
      config: z.object({
        url: z.string().url(),
        platform: z.string().min(1),
        checkType: z.string().min(1),
        checkUrl: z.string().url(),
        interval: z.number().min(10),
        alertChannels: z.array(z.string()),
        alertEmail: z.string().email().optional(),
      }),
      enabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const backend = createBackendClient(ctx.token)
      return backend.monitors.create({
        name: input.name,
        source: input.source,
        config: input.config,
        enabled: input.enabled,
      })
    }),

  testCheck: protectedProcedure
    .input(z.object({
      url: z.string().url(),
      type: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const backend = createBackendClient(ctx.token)
      return backend.monitors.testCheck({
        url: input.url,
        type: input.type,
      })
    }),
})