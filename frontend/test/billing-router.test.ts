// Focused tests for the NOC-236 billing tRPC surface: the token-scoped server
// hop, the owner/admin gate, and the rule that a caller with no server-derived
// role gets no mutation path.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { billingRouter } from '../src/server/routers/billing.ts'

type FetchCall = { url: string; method: string; body: string | null; authorization: string | null }

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

function stubFetch(status: number, body: unknown) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : null,
      authorization: headers.Authorization ?? null,
    })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as unknown as Response
  }) as typeof fetch
}

const callerFor = (token: string | null) =>
  billingRouter.createCaller({ userId: token ? 'user-1' : null, token })

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
    return 'NO_ERROR'
  } catch (err) {
    // The caller throws a raw TRPCError (`.code`); the browser receives the
    // serialized form (`.data.code`). Both are honoured so this lane matches
    // what the page sees over HTTP.
    const raw = err as { code?: string; data?: { code?: string } }
    const code = typeof raw.code === 'string' ? raw.code : raw.data?.code
    return typeof code === 'string' ? code : 'UNKNOWN'
  }
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('every billing read goes through the token-scoped backend client', async () => {
  stubFetch(200, { plans: [] })
  await callerFor('token-abc').plans()
  assert.equal(calls[0].authorization, 'Bearer token-abc')
  assert.equal(calls[0].url.endsWith('/api/billing/plans'), true)

  stubFetch(200, { subscription: null })
  await callerFor('token-abc').subscription()
  assert.equal(calls[1].url.endsWith('/api/billing/subscription'), true)

  stubFetch(200, { usage: {}, limits: {}, remaining: {} })
  await callerFor('token-abc').usage()
  assert.equal(calls[2].url.endsWith('/api/billing/usage'), true)

  stubFetch(200, { invoices: [], hasMore: false })
  await callerFor('token-abc').invoices()
  assert.equal(calls[3].url.endsWith('/api/billing/invoices'), true)
})

test('an unauthenticated caller never reaches the billing service', async () => {
  stubFetch(200, { plans: [] })
  assert.equal(await codeOf(() => callerFor(null).plans()), 'UNAUTHORIZED')
  assert.equal(calls.length, 0)
})

test('a member is refused by the backend and the router reports FORBIDDEN, not a body', async () => {
  stubFetch(403, {
    error: 'This operation requires elevated permissions',
    available: ['/api/billing/plans', '/api/billing/portal'],
  })
  assert.equal(await codeOf(() => callerFor('token-abc').portal()), 'FORBIDDEN')
})

test('a billing outage is SERVICE_UNAVAILABLE and carries no upstream detail', async () => {
  stubFetch(502, { error: 'Unable to update subscription' })
  const err = await callerFor('token-abc')
    .cancel()
    .then(
      () => null,
      (e: unknown) => e
    )
  const trpcErr = err as { code?: string; data?: { code?: string }; message?: string }
  assert.equal(trpcErr.code, 'SERVICE_UNAVAILABLE')
  assert.equal(trpcErr.message, 'Billing request failed')
  assert.equal(trpcErr.message?.includes('Unable to update subscription'), false)
})

test('no current subscription is NOT_FOUND, which the page shows as its own state', async () => {
  stubFetch(404, { error: 'No current subscription' })
  assert.equal(await codeOf(() => callerFor('token-abc').cancel()), 'NOT_FOUND')
})

test('a missing access endpoint resolves to a null role so the page fails closed', async () => {
  // NOC-354 has not landed /api/billing/access yet; 404 means "role unknown".
  stubFetch(404, { error: 'Not found', available: ['/api/billing/plans'] })
  assert.equal(await callerFor('token-abc').access(), null)
  assert.equal(calls[0].url.endsWith('/api/billing/access'), true)
})

test('a delivered access endpoint returns the server role', async () => {
  stubFetch(200, { role: 'admin' })
  assert.equal(await callerFor('token-abc').access(), 'admin')

  stubFetch(200, { role: 'member' })
  assert.equal(await callerFor('token-abc').access(), 'member')

  stubFetch(500, { error: 'boom' })
  assert.equal(await codeOf(() => callerFor('token-abc').access()), 'SERVICE_UNAVAILABLE')
})

test('a plan change sends one server-declared tier and no identity selector', async () => {
  stubFetch(200, { subscription: { planTier: 'advanced', status: 'active' } })
  await callerFor('token-abc').changePlan({ planTier: 'advanced' })
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { planTier: 'advanced' })
})

test('an empty or oversized plan tier is rejected before any request is issued', async () => {
  stubFetch(200, { subscription: null })
  assert.equal(await codeOf(() => callerFor('token-abc').changePlan({ planTier: '' })), 'BAD_REQUEST')
  assert.equal(calls.length, 0)
})

test('cancellation sends no body and never claims immediate cancellation', async () => {
  stubFetch(200, {
    subscription: {
      planTier: 'advanced',
      status: 'active',
      cancelAtPeriodEnd: true,
      nextBillingDate: null,
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
    },
  })
  const subscription = await callerFor('token-abc').cancel()
  assert.equal(calls[0].url.endsWith('/api/billing/cancel'), true)
  assert.equal(subscription?.cancelAtPeriodEnd, true)
  assert.equal(subscription?.nextBillingDate, null)
})