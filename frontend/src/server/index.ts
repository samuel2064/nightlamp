import { router } from './trpc'
import { playbookRouter } from './routers/playbook'
import { billingRouter } from './routers/billing'
import { dependencyRouter } from './routers/dependency'
import { monitorRouter } from './routers/monitor'
import { incidentRouter } from './routers/incident'
import { activityRouter } from './routers/activity'

export const appRouter = router({
  playbook: playbookRouter,
  billing: billingRouter,
  dependency: dependencyRouter,
  monitor: monitorRouter,
  incident: incidentRouter,
  activity: activityRouter,
})

export type AppRouter = typeof appRouter
