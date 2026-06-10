import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const healthRouter = router({
  status: publicProcedure
    .query(() => backend.health.get()),

  overview: publicProcedure
    .query(async () => {
      const [health, events, checks] = await Promise.all([
        backend.health.get(),
        backend.events.list({ limit: 5 }),
        backend.checkResults.list({ limit: 5 }),
      ])
      return { health, recentEvents: events.events, recentChecks: checks.results }
    }),
})
