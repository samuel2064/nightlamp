import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const billingRouter = router({
  subscription: publicProcedure
    .input(z.object({ email: z.string() }))
    .query(({ input }) => backend.billing.subscription(input.email)),

  usage: publicProcedure
    .input(z.object({ email: z.string() }))
    .query(({ input }) => backend.billing.usage(input.email)),
})
