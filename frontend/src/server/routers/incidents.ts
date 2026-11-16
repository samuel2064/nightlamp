import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const incidentsRouter = router({
  list: protectedProcedure
    .input(z.object({
      limit: z.number().optional(),
      offset: z.number().optional(),
      type: z.string().optional(),
      severity: z.string().optional(),
    }).optional())
    .query(({ ctx, input }) => createBackendClient(ctx.token).events.list(input)),

  acknowledge: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => backend.events.acknowledge(input.id)),
})
