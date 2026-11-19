import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const appsRouter = router({
  list: protectedProcedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }).optional())
    .query(async ({ ctx }) => {
      const backend = createBackendClient(ctx.token)
      return backend.apps.list()
    }),

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(1).max(120),
      url: z.string().url(),
      platform: z.enum(['vercel', 'railway', 'heroku', 'aws', 'gcp', 'azure', 'custom']),
      checkType: z.enum(['http', 'tcp', 'keyword']),
      checkTarget: z.string().min(1),
      checkIntervalSec: z.number().min(10).max(86400),
      checkTimeoutSec: z.number().min(1).max(30),
      keyword: z.string().max(256).optional(),
      enabled: z.boolean().optional(),
      alertChannelId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const backend = createBackendClient(ctx.token)
      return backend.apps.create({
        name: input.name,
        url: input.url,
        platform: input.platform,
        checkType: input.checkType,
        checkTarget: input.checkTarget,
        checkIntervalSec: input.checkIntervalSec,
        checkTimeoutSec: input.checkTimeoutSec,
        keyword: input.keyword ?? undefined,
        enabled: input.enabled,
        alertChannelId: input.alertChannelId,
      })
    }),

  testCheck: protectedProcedure
    .input(z.object({
      appId: z.string().min(1),
      checkType: z.enum(['http', 'tcp', 'keyword']),
      checkTarget: z.string().min(1),
      checkTimeoutSec: z.number().min(1).max(30).optional(),
      keyword: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const backend = createBackendClient(ctx.token)
      return backend.apps.testCheck(input.appId, {
        checkType: input.checkType,
        checkTarget: input.checkTarget,
        checkTimeoutSec: input.checkTimeoutSec,
        keyword: input.keyword ?? undefined,
      })
    }),

  previewCheck: protectedProcedure
    .input(z.object({
      checkType: z.enum(['http', 'tcp', 'keyword']),
      checkTarget: z.string().min(1),
      checkTimeoutSec: z.number().min(1).max(30).optional(),
      keyword: z.string().max(256).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const backend = createBackendClient(ctx.token)
      return backend.apps.previewCheck({
        checkType: input.checkType,
        checkTarget: input.checkTarget,
        checkTimeoutSec: input.checkTimeoutSec,
        keyword: input.keyword ?? undefined,
      })
    }),
})