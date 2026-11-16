import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const playbookRouter = router({
  list: protectedProcedure
    .query(({ ctx }) => createBackendClient(ctx.token).playbook.list()),

  search: protectedProcedure
    .input(z.object({ q: z.string() }))
    .query(({ ctx, input }) => createBackendClient(ctx.token).playbook.search(input.q)),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => createBackendClient(ctx.token).playbook.get(input.id)),

  run: protectedProcedure
    .input(z.object({
      id: z.string(),
      context: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).playbook.run(input.id, input.context)),

  decision: protectedProcedure
    .input(z.object({
      executionId: z.string(),
      decision: z.string(),
    }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).playbook.decision(input.executionId, input.decision)),

  getExecution: protectedProcedure
    .input(z.object({ executionId: z.string() }))
    .query(({ ctx, input }) => createBackendClient(ctx.token).playbook.getExecution(input.executionId)),
})
