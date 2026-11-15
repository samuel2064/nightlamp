import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const remediationRouter = router({
  listRuns: protectedProcedure
    .input(
      z.object({
        status: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional(),
    )
    .query(({ ctx, input }) => createBackendClient(ctx.token).remediation.listRuns(input)),

  approveRun: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).remediation.approveRun(input.id)),

  rejectRun: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).remediation.rejectRun(input.id)),

  retryRun: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => createBackendClient(ctx.token).remediation.retryRun(input.id)),

  listPolicies: protectedProcedure
    .query(({ ctx }) => createBackendClient(ctx.token).remediation.listPolicies()),

  updatePolicy: protectedProcedure
    .input(z.object({
      id: z.string(),
      auto_approve: z.boolean().optional(),
      require_dry_run: z.boolean().optional(),
      cooldown_minutes: z.number().optional(),
    }))
    .mutation(({ ctx, input }) =>
      createBackendClient(ctx.token).remediation.updatePolicy(input.id, {
        auto_approve: input.auto_approve,
        require_dry_run: input.require_dry_run,
        cooldown_minutes: input.cooldown_minutes,
      })),
})
