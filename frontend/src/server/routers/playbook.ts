import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { backend } from '../services/backend'

export const playbookRouter = router({
  list: publicProcedure
    .input(
      z.object({
        source: z.string().optional(),
        severity: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().optional(),
        offset: z.number().optional(),
      }).optional(),
    )
    .query(({ input }) => backend.playbooks.list(input)),

  get: publicProcedure
    .input(z.object({ id: z.number() }))
    .query(({ input }) => backend.playbooks.get(input.id)),

  failureTypes: publicProcedure
    .query(() => backend.playbooks.failureTypes()),

  create: publicProcedure
    .input(z.object({
      failureType: z.string(),
      source: z.string(),
      severity: z.string(),
      title: z.string(),
      description: z.string().optional(),
      affectedResource: z.string(),
      diagnosis: z.string().optional(),
      remediation: z.string().optional(),
      relatedEntries: z.string().optional(),
    }))
    .mutation(({ input }) => backend.playbooks.create(input)),

  updateStatus: publicProcedure
    .input(z.object({
      id: z.number(),
      status: z.string(),
      resolvedAt: z.string().optional(),
    }))
    .mutation(({ input }) => backend.playbooks.updateStatus(input.id, input.status, input.resolvedAt)),

  autoGenerate: publicProcedure
    .input(z.object({
      failureType: z.string(),
      resource: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }))
    .mutation(({ input }) => backend.playbooks.autoGenerate(input.failureType, input.resource, input.details)),
})
