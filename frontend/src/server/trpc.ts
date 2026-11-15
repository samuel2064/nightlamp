import { initTRPC, TRPCError } from '@trpc/server'

export interface TRPCContext {
  userId: string | null
  token: string | null
}

const t = initTRPC.context<TRPCContext>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' })
  }
  return next({ ctx: { ...ctx, userId: ctx.userId, token: ctx.token } })
})
