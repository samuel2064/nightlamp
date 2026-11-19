import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const notificationsRouter = router({
  createChannel: protectedProcedure
    .input(z.object({
      name: z.string().min(1),
      type: z.enum(['email-smtp', 'slack-webhook', 'in-app-websocket']),
      config: z.record(z.unknown()),
    }))
    .mutation(async ({ ctx, input }) => {
      const backend = createBackendClient(ctx.token)
      return backend.notifications.createChannel({
        name: input.name,
        type: input.type,
        config: input.config,
      })
    }),

  listChannels: protectedProcedure
    .input(z.object({ limit: z.number().optional(), offset: z.number().optional() }).optional())
    .query(async ({ ctx }) => {
      const backend = createBackendClient(ctx.token)
      return backend.notifications.listChannels()
    }),
})