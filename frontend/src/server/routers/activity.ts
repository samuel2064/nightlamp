import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const activityRouter = router({
  list: publicProcedure.query(() => backend.activity.list()),
})
