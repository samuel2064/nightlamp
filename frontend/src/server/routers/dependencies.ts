import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const dependenciesRouter = router({
  list: publicProcedure
    .query(async () => {
      const deps = await backend.dependencies.list()
      return { dependencies: deps, count: deps.length }
    }),

  updates: publicProcedure
    .input(z.object({ breakingOnly: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const updates = await backend.dependencies.updates(input?.breakingOnly)
      return { updates, count: updates.length }
    }),
})
