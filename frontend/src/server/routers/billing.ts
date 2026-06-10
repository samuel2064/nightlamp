import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const billingRouter = router({
  summary: publicProcedure
    .query(() => backend.billing.summary()),

  subscriptions: publicProcedure
    .query(() => backend.billing.listSubscriptions()),
})
