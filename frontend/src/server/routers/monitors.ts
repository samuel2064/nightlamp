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
      url: z.string().url(),
      platform: z.string().min(1),
      checkType: z.enum(['http', 'tcp', 'keyword']).default('http'),
      checkTarget: z.string().min(1),
      checkIntervalSec: z.number().int().min(10).max(86400).optional(),
      checkTimeoutSec: z.number().int().min(1).max(30).optional(),
      keyword: z.string().min(1).optional(),
      enabled: z.boolean().optional(),
      alertChannelId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { app } = await createBackendClient(ctx.token).apps.create(input)
      return app
    }),

  testCheck: protectedProcedure
    .input(z.object({
      checkTarget: z.string().min(1),
      checkType: z.enum(['http', 'tcp', 'keyword']).default('http'),
      checkTimeoutSec: z.number().int().min(1).max(30).optional(),
      keyword: z.string().min(1).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { result } = await createBackendClient(ctx.token).apps.previewCheck({
        checkTarget: input.checkTarget,
        checkType: input.checkType,
        checkTimeoutSec: input.checkTimeoutSec,
        keyword: input.keyword,
      })
      return result
    }),

  testCheckPersisted: protectedProcedure
    .input(z.object({
      appId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const { result } = await createBackendClient(ctx.token).apps.testCheck(input.appId)
      return result
    }),

  channels: protectedProcedure
    .query(async ({ ctx }) => {
      const { channels } = await createBackendClient(ctx.token).channels.list()
      return { channels }
    }),

  createChannel: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      type: z.enum(['email-smtp', 'slack-webhook', 'in-app-websocket']),
      config: z.record(z.any()),
    }))
    .mutation(async ({ ctx, input }) => {
      return createBackendClient(ctx.token).channels.create(input)
    }),
})
