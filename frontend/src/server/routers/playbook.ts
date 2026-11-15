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

  run: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => backend.playbook.run(input.id)),

  decision: publicProcedure
    .input(z.object({
      executionId: z.string(),
      stepId: z.string(),
      answer: z.array(z.string()),
      skipped: z.boolean().optional(),
    }))
    .mutation(({ input }) => backend.playbook.decision(input.executionId, input.stepId, input.answer, input.skipped)),

  getExecution: publicProcedure
    .input(z.object({ executionId: z.string() }))
    .query(({ input }) => backend.playbook.getExecution(input.executionId)),
})

export type PlaybookRouter = typeof playbookRouter