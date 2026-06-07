import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const incidentRouter = router({
  list: publicProcedure.query(() => backend.incidents.list()),
})
