import { z } from 'zod'
import { router, protectedProcedure, tokenProcedure } from '../trpc'
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

  // Durable acknowledgement: the protected backend persists acknowledged = 1
  // tenant-scoped. The router reports exactly what the backend confirms - it
  // never synthesizes a success. A missing event answers 404 and a cross-tenant
  // id answers 403/404 from the backend.
  acknowledge: tokenProcedure
    .input(z.object({ id: z.string().min(1) }).strict())
    .mutation(async ({ ctx, input }) => {
      return createBackendClient(ctx.token).events.acknowledge(input.id)
    }),
})