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
})
