import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { router, protectedProcedure } from '../trpc'
import {
  createBackendClient,
  isBillingRequestError,
  type BillingRole,
} from '../services/backend'

/**
 * tRPC error codes are a closed enum, so the provider-failure and
 * unavailable-service distinction is carried by the pair (code, stable message
 * suffix): the browser reads `data.code` plus the suffix on the sanitized
 * message, never an upstream body.
 */
const TRPC_CODE_BY_BILLING_CODE = {
  unauthenticated: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  not_found: 'NOT_FOUND',
  invalid_request: 'BAD_REQUEST',
  unavailable: 'SERVICE_UNAVAILABLE',
  provider_failure: 'INTERNAL_SERVER_ERROR',
  unknown: 'INTERNAL_SERVER_ERROR',
} as const

/**
 * A failed billing read or write becomes a tRPC error carrying a code only. The
 * upstream body is never attached, so the browser receives no endpoint inventory,
 * no Stripe detail and no internal text.
 */
function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) throw err
  if (isBillingRequestError(err)) {
    const code = TRPC_CODE_BY_BILLING_CODE[err.code]
    const message =
      err.code === 'provider_failure' ? 'Billing request failed (provider)' : 'Billing request failed'
    return new TRPCError({ code, message })
  }
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Billing request failed' })
}

/** Read path: the token is required, a failure is reported as a code, never a body. */
function billingQuery<T>(run: (token: string) => Promise<T>) {
  return protectedProcedure.query(({ ctx }) => {
    if (!ctx.token) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' })
    }
    return run(ctx.token).catch((err: unknown) => {
      throw toTRPCError(err)
    })
  })
}

/** Write path: identical contract, separate so mutations stay explicit. */
function billingMutation<T>(run: (token: string) => Promise<T>) {
  return protectedProcedure.mutation(({ ctx }) => {
    if (!ctx.token) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' })
    }
    return run(ctx.token).catch((err: unknown) => {
      throw toTRPCError(err)
    })
  })
}

const client = (token: string) => createBackendClient(token).billing

export const billingRouter = router({
  plans: billingQuery((token) => client(token).plans()),

  subscription: billingQuery((token) => client(token).subscription()),

  usage: billingQuery((token) => client(token).usage()),

  invoices: billingQuery((token) => client(token).invoices()),

  /**
   * Authoritative caller role from NOC-354. Until that endpoint exists the
   * backend answers 404, which becomes a null role here: the page then fails
   * closed and offers no mutation control on an unknown role.
   */
  access: billingQuery(async (token): Promise<BillingRole | null> => {
    try {
      return await client(token).access()
    } catch (err) {
      if (isBillingRequestError(err) && err.code === 'not_found') return null
      throw err
    }
  }),

  portal: billingMutation((token) => client(token).portalUrl()),

  changePlan: protectedProcedure
    .input(
      z.object({
        // The tier list is server-declared; the frontend never hard-codes an alias.
        planTier: z.string().min(1).max(64),
      })
    )
    .mutation(({ ctx, input }) => {
      if (!ctx.token) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' })
      }
      return client(ctx.token)
        .changePlan(input.planTier)
        .catch((err: unknown) => {
          throw toTRPCError(err)
        })
    }),

  cancel: billingMutation((token) => client(token).cancel()),
})
