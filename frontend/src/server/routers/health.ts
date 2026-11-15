import { router, protectedProcedure } from '../trpc'
import { createBackendClient } from '../services/backend'

export const healthRouter = router({
  status: protectedProcedure
    .query(({ ctx }) => createBackendClient(ctx.token).health.get()),

  overview: protectedProcedure
    .query(async ({ ctx }) => {
      const backend = createBackendClient(ctx.token)
      const [health, events, checks] = await Promise.all([
        backend.health.get(),
        backend.events.list({ limit: 5 }),
        backend.checkResults.list({ limit: 5 }),
      ])
      return { health, recentEvents: events.events, recentChecks: checks.results }
    }),
})
