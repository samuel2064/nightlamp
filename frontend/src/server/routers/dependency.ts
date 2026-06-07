import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const dependencyRouter = router({
  health: publicProcedure
    .query(() => backend.dependencies.health()),
})
