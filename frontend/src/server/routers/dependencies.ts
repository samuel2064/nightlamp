import { z } from 'zod'
import { router, publicProcedure } from '../trpc'

interface Dependency {
  id: string
  name: string
  currentVersion: string
  specifiedRange: string
  isDev: boolean
}

interface DependencyUpdate {
  id: string
  dependencyId: string
  availableVersion: string
  currentVersion: string
  changeType: string
  isBreaking: boolean
  changelogUrl: string | null
  detectedAt: string
}

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3000'

async function fetchDeps(): Promise<Dependency[]> {
  const res = await fetch(`${BACKEND_URL}/api/dependencies`)
  if (!res.ok) return []
  const data = await res.json()
  return data.dependencies || []
}

async function fetchUpdates(breakingOnly = false): Promise<DependencyUpdate[]> {
  const url = `${BACKEND_URL}/api/dependencies/updates${breakingOnly ? '?breaking=true' : ''}`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = await res.json()
  return data.updates || []
}

export const dependenciesRouter = router({
  list: publicProcedure
    .query(async () => {
      const deps = await fetchDeps()
      return { dependencies: deps, count: deps.length }
    }),

  updates: publicProcedure
    .input(z.object({ breakingOnly: z.boolean().optional() }).optional())
    .query(async ({ input }) => {
      const updates = await fetchUpdates(input?.breakingOnly)
      return { updates, count: updates.length }
    }),
})
