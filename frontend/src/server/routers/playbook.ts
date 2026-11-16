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
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).playbook.run(input.id)),

  decision: protectedProcedure
    .input(z.object({
      executionId: z.string(),
      stepId: z.string(),
      answer: z.array(z.string()),
      skipped: z.boolean().optional(),
    }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).playbook.decision(input.executionId, input.stepId, input.answer, input.skipped)),

  getExecution: protectedProcedure
    .input(z.object({ executionId: z.string() }))
    .query(({ ctx, input }) => createBackendClient(ctx.token).playbook.getExecution(input.executionId)),
})
