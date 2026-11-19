import { router } from './trpc'
import { monitorsRouter } from './routers/monitors'
import { appsRouter } from './routers/apps'
import { notificationsRouter } from './routers/notifications'
import { incidentsRouter } from './routers/incidents'
import { healthRouter } from './routers/health'
import { dependenciesRouter } from './routers/dependencies'
import { activityRouter } from './routers/activity'
import { billingRouter } from './routers/billing'
import { playbookRouter } from './routers/playbook'
import { remediationRouter } from './routers/remediation'

export const appRouter = router({
  monitors: monitorsRouter,
  apps: appsRouter,
  notifications: notificationsRouter,
  incidents: incidentsRouter,
  health: healthRouter,
  dependencies: dependenciesRouter,
  activity: activityRouter,
  billing: billingRouter,
  playbook: playbookRouter,
  remediation: remediationRouter,
})

export type AppRouter = typeof appRouter
