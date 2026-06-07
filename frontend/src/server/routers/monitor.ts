import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const monitorRouter = router({
  health: publicProcedure.query(() => backend.monitors.health()),
})
