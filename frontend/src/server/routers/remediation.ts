import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const remediationRouter = router({
  listRuns: publicProcedure
    .input(
      z.object({
        status: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional(),
    )
    .query(({ input }) => backend.remediation.listRuns(input)),

  approveRun: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => backend.remediation.approveRun(input.id)),

  rejectRun: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => backend.remediation.rejectRun(input.id)),

  retryRun: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => backend.remediation.retryRun(input.id)),

  listPolicies: publicProcedure
    .query(() => backend.remediation.listPolicies()),

  updatePolicy: publicProcedure
    .input(z.object({
      id: z.string(),
      auto_approve: z.boolean().optional(),
      require_dry_run: z.boolean().optional(),
      cooldown_minutes: z.number().optional(),
    }))
    .mutation(({ input }) => backend.remediation.updatePolicy(input.id, input)),
})
