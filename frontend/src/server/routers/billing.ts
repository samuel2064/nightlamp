import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const billingRouter = router({
  summary: protectedProcedure
    .query(({ ctx }) => createBackendClient(ctx.token).billing.summary()),

  subscriptions: protectedProcedure
    .query(({ ctx }) => createBackendClient(ctx.token).billing.listSubscriptions()),

  portal: protectedProcedure
    .mutation(({ ctx }) => createBackendClient(ctx.token).billing.portalUrl()),
})
