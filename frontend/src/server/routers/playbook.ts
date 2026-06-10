import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const playbookRouter = router({
  list: publicProcedure
    .query(() => backend.playbook.list()),

  search: publicProcedure
    .input(z.object({ q: z.string() }))
    .query(({ input }) => backend.playbook.search(input.q)),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => backend.playbook.get(input.id)),
})
