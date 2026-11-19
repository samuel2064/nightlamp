import { z } from 'zod'
import { router, protectedProcedure } from '../trpc'

export const onboardingRouter = router({
  start: protectedProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/onboarding/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.token}`,
        },
        body: JSON.stringify(input),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error ?? 'Failed to start onboarding')
      }
      return res.json()
    }),

  status: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .query(async ({ input, ctx }) => {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/onboarding/${input.sessionId}/status`, {
        headers: {
          Authorization: `Bearer ${ctx.token}`,
        },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error ?? 'Failed to get onboarding status')
      }
      return res.json()
    }),

  step: protectedProcedure
    .input(z.object({
      sessionId: z.string(),
      step: z.string(),
      data: z.record(z.unknown()).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/onboarding/${input.sessionId}/step`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ctx.token}`,
        },
        body: JSON.stringify({ step: input.step, data: input.data }),
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error ?? 'Failed to advance onboarding step')
      }
      return res.json()
    }),

  complete: protectedProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const res = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL}/api/onboarding/${input.sessionId}/complete`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.token}`,
        },
      })
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error ?? 'Failed to complete onboarding')
      }
      return res.json()
    }),
})