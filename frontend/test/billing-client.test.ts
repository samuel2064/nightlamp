// Focused tests for the NOC-236 billing server client: identity fields are
// dropped before they can reach the browser, and a non-2xx response is a code,
// never the upstream body.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  BillingRequestError,
  billingErrorCode,
  createBackendClient,
  isBillingRequestError,
} from '../src/server/services/backend.ts'

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

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('plans are mapped and never carry fields the server did not send', async () => {
  stubFetch(200, {
    plans: [
      { id: 'advanced', name: 'Advanced Support', price: 299, monitors: 20, reports: 500, storageMb: 500 },
    ],
  })
  const plans = await createBackendClient('token-abc').billing.plans()
  assert.deepEqual(plans, [
    { id: 'advanced', name: 'Advanced Support', price: 299, monitors: 20, reports: 500, storageMb: 500 },
  ])
  assert.deepEqual(Object.keys(plans[0]), ['id', 'name', 'price', 'monitors', 'reports', 'storageMb'])
  assert.equal(calls[0].authorization, 'Bearer token-abc')
})

test('the subscription response drops customer, subscription and Stripe identifiers', async () => {
  stubFetch(200, {
    subscription: {
      id: 'sub-uuid',
      customerId: 'cus-uuid',
      stripeSubscriptionId: 'sub_stripe',
      planTier: 'advanced',
      status: 'active',
      currentPeriodStart: '2026-11-01T00:00:00.000Z',
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      limits: { monitors: 20, reports: 500, storageMb: 500 },
      price: 299,
      currency: 'usd',
      billingPeriod: 'month',
      nextBillingDate: '2026-12-01T00:00:00.000Z',
    },
  })
  const subscription = await createBackendClient('token-abc').billing.subscription()
  assert.ok(subscription)
  assert.deepEqual(Object.keys(subscription), [
    'planTier',
    'status',
    'currentPeriodStart',
    'currentPeriodEnd',
    'cancelAtPeriodEnd',
    'limits',
    'price',
    'currency',
    'billingPeriod',
    'nextBillingDate',
  ])
  assert.equal(JSON.stringify(subscription).includes('sub_stripe'), false)
  assert.equal(JSON.stringify(subscription).includes('cus-uuid'), false)
})

test('a null subscription stays null and is not turned into a zero plan', async () => {
  stubFetch(200, { subscription: null })
  const subscription = await createBackendClient('token-abc').billing.subscription()
  assert.equal(subscription, null)
})

test('invoices drop every identifier: the Stripe row id and the invoice number', async () => {
  stubFetch(200, {
    invoices: [
      {
        id: 'in_stripe_id',
        number: 'AB-0001',
        status: 'paid',
        currency: 'usd',
        amountDue: 29900,
        amountPaid: 29900,
        created: 1761955200,
        invoiceUrl: 'https://invoice.stripe.com/i/abc',
        pdfUrl: 'https://invoice.stripe.com/i/abc/pdf',
      },
    ],
    hasMore: false,
  })
  const invoices = await createBackendClient('token-abc').billing.invoices()
  assert.equal(invoices.length, 1)
  assert.deepEqual(Object.keys(invoices[0]), [
    'status',
    'currency',
    'amountDue',
    'amountPaid',
    'created',
    'invoiceUrl',
    'pdfUrl',
  ])
  const serialized = JSON.stringify(invoices)
  assert.equal(serialized.includes('in_stripe_id'), false)
  // The plan prohibits invoice identifiers in the browser, so the number the
  // server sent never leaves the server hop.
  assert.equal(serialized.includes('AB-0001'), false)
})

test('a malformed invoice entry fails the read instead of rendering a zero-amount invoice', async () => {
  stubFetch(200, {
    invoices: [
      {
        id: 'in_stripe_id',
        status: 'paid',
        currency: 'usd',
        amountDue: 'not-a-number',
        amountPaid: 29900,
        created: 1761955200,
        invoiceUrl: null,
        pdfUrl: null,
      },
    ],
  })
  const err = await createBackendClient('token-abc')
    .billing.invoices()
    .then(
      () => null,
      (e: unknown) => e
    )
  assert.ok(isBillingRequestError(err))
  assert.equal((err as BillingRequestError).code, 'provider_failure')
})

test('a 502 is a provider failure, and the upstream body is not carried', async () => {
  stubFetch(502, { error: 'Unable to load billing history' })
  const err = await createBackendClient('token-abc')
    .billing.invoices()
    .then(
      () => null,
      (e: unknown) => e
    )
  assert.ok(isBillingRequestError(err))
  assert.equal((err as BillingRequestError).code, 'provider_failure')
  assert.equal((err as BillingRequestError).status, 502)
  assert.equal((err as Error).message, 'Billing request failed (provider_failure)')
  assert.equal((err as Error).message.includes('Unable to load billing history'), false)
})

test('a network-level failure is unavailable, never a zero or an empty list', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch
  const err = await createBackendClient('token-abc')
    .billing.plans()
    .then(
      () => null,
      (e: unknown) => e
    )
  assert.ok(isBillingRequestError(err))
  assert.equal((err as BillingRequestError).code, 'unavailable')
})

test('a 2xx body that is not usable JSON is a provider failure, not an empty payload', async () => {
  globalThis.fetch = (async () => {
    return {
      ok: true,
      status: 200,
      text: async () => '<html>gateway splash</html>',
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as unknown as Response
  }) as typeof fetch
  const err = await createBackendClient('token-abc')
    .billing.usage()
    .then(
      () => null,
      (e: unknown) => e
    )
  assert.ok(isBillingRequestError(err))
  assert.equal((err as BillingRequestError).code, 'provider_failure')
})

test('billing status codes map to truthful failure codes', () => {
  assert.equal(billingErrorCode(400), 'invalid_request')
  assert.equal(billingErrorCode(401), 'unauthenticated')
  assert.equal(billingErrorCode(403), 'forbidden')
  assert.equal(billingErrorCode(404), 'not_found')
  // The billing service answered with a failure: its provider step did not
  // complete. This is a different truth from a service that never answered.
  assert.equal(billingErrorCode(500), 'provider_failure')
  assert.equal(billingErrorCode(502), 'provider_failure')
  assert.equal(billingErrorCode(503), 'unavailable')
  assert.equal(billingErrorCode(504), 'unavailable')
  assert.equal(billingErrorCode(418), 'unknown')
  assert.equal(billingErrorCode(null), 'unknown')
})

test('a malformed success payload is a provider failure, never a silent zero', async () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      'plans payload is not an array',
      () => {
        stubFetch(200, { plans: { id: 'advanced' } })
        return createBackendClient('token-abc').billing.plans()
      },
    ],
    [
      'plan entry is missing its price',
      () => {
        stubFetch(200, { plans: [{ id: 'advanced', name: 'Advanced', monitors: 20, reports: 500, storageMb: 500 }] })
        return createBackendClient('token-abc').billing.plans()
      },
    ],
    [
      'subscription object is missing planTier',
      () => {
        stubFetch(200, { subscription: { status: 'active', limits: {}, price: 1, currency: 'usd', billingPeriod: 'month', cancelAtPeriodEnd: false } })
        return createBackendClient('token-abc').billing.subscription()
      },
    ],
    [
      'usage payload is missing limits',
      () => {
        stubFetch(200, { usage: { monitors: 0, reports: 0, storageMb: 0 }, remaining: { monitors: 0, reports: 0, storageMb: 0 } })
        return createBackendClient('token-abc').billing.usage()
      },
    ],
    [
      'subscription key is absent entirely',
      () => {
        stubFetch(200, {})
        return createBackendClient('token-abc').billing.subscription()
      },
    ],
  ]
  for (const [name, run] of cases) {
    const err = await run().then(
      () => null,
      (e: unknown) => e
    )
    assert.ok(isBillingRequestError(err), `expected a billing failure for: ${name}`)
    assert.equal((err as BillingRequestError).code, 'provider_failure', name)
  }
})

test('an explicit null subscription stays a no-subscription read', async () => {
  stubFetch(200, { subscription: null })
  const subscription = await createBackendClient('token-abc').billing.subscription()
  assert.equal(subscription, null)
})

test('the access role is validated against the roles the server can declare', async () => {
  stubFetch(200, { role: 'owner' })
  assert.equal(await createBackendClient('token-abc').billing.access(), 'owner')

  stubFetch(200, { role: 'none' })
  assert.equal(await createBackendClient('token-abc').billing.access(), 'none')

  // An unexpected role value fails closed instead of being trusted.
  stubFetch(200, { role: 'superadmin' })
  assert.equal(await createBackendClient('token-abc').billing.access(), null)

  stubFetch(200, { role: 42 })
  assert.equal(await createBackendClient('token-abc').billing.access(), null)
})

test('a member is refused by the server with 403 and the page is told forbidden', async () => {
  stubFetch(403, { error: 'This operation requires elevated permissions' })
  const err = await createBackendClient('token-abc')
    .billing.portalUrl()
    .then(
      () => null,
      (e: unknown) => e
    )
  assert.ok(isBillingRequestError(err))
  assert.equal((err as BillingRequestError).code, 'forbidden')
})

test('a plan change posts only the server-declared tier and no identity selector', async () => {
  stubFetch(200, {
    subscription: {
      id: 'sub-uuid',
      customerId: 'cus-uuid',
      stripeSubscriptionId: 'sub_stripe',
      planTier: 'advanced',
      status: 'active',
      currentPeriodStart: '2026-11-01T00:00:00.000Z',
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      cancelAtPeriodEnd: false,
      createdAt: '2026-11-01T00:00:00.000Z',
      limits: { monitors: 20, reports: 500, storageMb: 500 },
      price: 299,
      currency: 'usd',
      billingPeriod: 'month',
      nextBillingDate: '2026-12-01T00:00:00.000Z',
    },
  })
  await createBackendClient('token-abc').billing.changePlan('advanced')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].url.endsWith('/api/billing/change-plan'), true)
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { planTier: 'advanced' })
})

test('cancellation posts an empty body and returns the updated subscription', async () => {
  stubFetch(200, {
    subscription: {
      id: 'sub-uuid',
      customerId: 'cus-uuid',
      stripeSubscriptionId: 'sub_stripe',
      planTier: 'advanced',
      status: 'active',
      currentPeriodStart: '2026-11-01T00:00:00.000Z',
      currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
      createdAt: '2026-11-01T00:00:00.000Z',
      limits: { monitors: 20, reports: 500, storageMb: 500 },
      price: 299,
      currency: 'usd',
      billingPeriod: 'month',
      nextBillingDate: null,
    },
  })
  const subscription = await createBackendClient('token-abc').billing.cancel()
  assert.equal(calls[0].url.endsWith('/api/billing/cancel'), true)
  assert.equal(subscription?.cancelAtPeriodEnd, true)
})

test('a portal response without a URL is a failure, not a silent success', async () => {
  stubFetch(200, { url: null })
  const err = await createBackendClient('token-abc')
    .billing.portalUrl()
    .then(
      () => null,
      (e: unknown) => e
    )
  assert.ok(isBillingRequestError(err))
  assert.equal((err as BillingRequestError).code, 'unknown')
})