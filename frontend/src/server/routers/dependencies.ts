import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'

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

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

async function fetchDeps(token: string | null): Promise<Dependency[]> {
  const res = await fetch(`${BACKEND_URL}/api/dependencies`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) return []
  const data = await res.json()
  return data.dependencies || []
}

async function fetchUpdates(token: string | null, breakingOnly = false): Promise<DependencyUpdate[]> {
  const url = `${BACKEND_URL}/api/dependencies/updates${breakingOnly ? '?breaking=true' : ''}`
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  })
  if (!res.ok) return []
  const data = await res.json()
  return data.updates || []
}

export const dependenciesRouter = router({
  list: protectedProcedure
    .query(async ({ ctx }) => {
      const deps = await fetchDeps(ctx.token)
      return { dependencies: deps, count: deps.length }
    }),

  updates: protectedProcedure
    .input(z.object({ breakingOnly: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const updates = await fetchUpdates(ctx.token, input?.breakingOnly)
      return { updates, count: updates.length }
    }),
})
