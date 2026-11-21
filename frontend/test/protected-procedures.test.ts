// Protected procedure contracts (NOC-340 remediation), exercised against the
// real production routers with a stubbed backend fetch:
// - the durable acknowledgement proxies the tenant-scoped backend and reports
//   exactly what the backend confirms (success, backend failure, missing
//   event, cross-tenant rejection)
// - the feedback submission schema is strict and requires a bearer token
// - the receipt route answers a safe metadata-only DTO, never the raw record

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TRPCError } from '@trpc/server'
import { appRouter } from '../src/server/index.ts'

type CallerCtx = { userId: string | null; token: string | null }

function caller(ctx: CallerCtx) {
  return appRouter.createCaller(ctx)
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>
): () => void {
  const original = globalThis.fetch
  globalThis.fetch = handler as unknown as typeof globalThis.fetch
  return () => {
    globalThis.fetch = original
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const AUTH: CallerCtx = { userId: 'user-1', token: 'token-1' }

// ---- Durable acknowledgement (finding 1) ----

test('an acknowledgement is durable: the backend ack is proxied and reported', async () => {
  const calls: { url: string; method: string; body: unknown; auth?: string }[] = []
  const restore = stubFetch(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: (init?.headers as Record<string, string>)?.Authorization,
    })
    return jsonResponse({ success: true, id: 'evt-1' })
  })
  try {
    const result = await caller(AUTH).incidents.acknowledge({ id: 'evt-1' })
    assert.deepEqual(result, { success: true, id: 'evt-1' })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/api\/events\/acknowledge$/)
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, { id: 'evt-1' })
    assert.equal(calls[0].auth, 'Bearer token-1')
  } finally {
    restore()
  }
})

test('an acknowledgement reports a backend failure instead of a synthetic success', async () => {
  const restore = stubFetch(async () => jsonResponse({ error: 'db unavailable' }, 500))
  try {
    await assert.rejects(() => caller(AUTH).incidents.acknowledge({ id: 'evt-1' }), /Backend API error 500/)
  } finally {
    restore()
  }
})

test('an acknowledgement of a missing event surfaces the backend 404', async () => {
  const restore = stubFetch(async () => jsonResponse({ error: 'Event not found' }, 404))
  try {
    await assert.rejects(() => caller(AUTH).incidents.acknowledge({ id: 'evt-missing' }), /Backend API error 404/)
  } finally {
    restore()
  }
})

test('a cross-tenant acknowledgement is refused by the backend 403', async () => {
  const restore = stubFetch(async () => jsonResponse({ error: 'Forbidden' }, 403))
  try {
    await assert.rejects(() => caller(AUTH).incidents.acknowledge({ id: 'evt-other-tenant' }), /Backend API error 403/)
  } finally {
    restore()
  }
})

test('an acknowledgement without a bearer token fails closed', async () => {
  let fetchCalls = 0
  const restore = stubFetch(async () => {
    fetchCalls += 1
    return jsonResponse({ success: true })
  })
  try {
    await assert.rejects(
      () => caller({ userId: 'user-1', token: null }).incidents.acknowledge({ id: 'evt-1' }),
      (error: unknown) => error instanceof TRPCError && error.code === 'UNAUTHORIZED'
    )
    assert.equal(fetchCalls, 0, 'no backend request is made without a token')
  } finally {
    restore()
  }
})

// ---- Feedback procedure contracts (finding 5) ----

const SURVEY_SUBMISSION = {
  response_id: 'resp-1',
  kind: 'survey' as const,
  survey_id: 'nps_day14' as const,
  score: 9,
  response: { score: 9 },
}

test('a feedback submission requires a bearer token', async () => {
  let fetchCalls = 0
  const restore = stubFetch(async () => {
    fetchCalls += 1
    return jsonResponse({ success: true })
  })
  try {
    await assert.rejects(
      () => caller({ userId: 'user-1', token: null }).feedback.submit(SURVEY_SUBMISSION),
      (error: unknown) => error instanceof TRPCError && error.code === 'UNAUTHORIZED'
    )
    assert.equal(fetchCalls, 0)
  } finally {
    restore()
  }
})

test('an unknown top-level key is rejected before it reaches the backend', async () => {
  let fetchCalls = 0
  const restore = stubFetch(async () => {
    fetchCalls += 1
    return jsonResponse({ success: true })
  })
  try {
    await assert.rejects(
      () =>
        caller(AUTH).feedback.submit({
          ...SURVEY_SUBMISSION,
          unexpected: 'nope',
        } as never),
      (error: unknown) => {
        assert.ok(error instanceof TRPCError)
        assert.equal(error.code, 'BAD_REQUEST')
        return true
      }
    )
    assert.equal(fetchCalls, 0, 'the malformed payload is never proxied')
  } finally {
    restore()
  }
})

test('a valid submission is proxied with the token and the exact payload', async () => {
  const calls: { url: string; method: string; body: unknown; auth?: string }[] = []
  const restore = stubFetch(async (url, init) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: (init?.headers as Record<string, string>)?.Authorization,
    })
    return jsonResponse({
      success: true,
      duplicate: false,
      response_id: 'resp-1',
      event_id: 'resp-1',
      event: 'survey_completed',
      received_at: '2026-11-19T10:00:00.000Z',
    })
  })
  try {
    const receipt = await caller(AUTH).feedback.submit(SURVEY_SUBMISSION)
    assert.equal(receipt.success, true)
    assert.match(calls[0].url, /\/api\/feedback\/responses$/)
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, SURVEY_SUBMISSION)
    assert.equal(calls[0].auth, 'Bearer token-1')
  } finally {
    restore()
  }
})

test('the receipt route answers the safe metadata-only DTO', async () => {
  const restore = stubFetch(async () =>
    jsonResponse({
      item: {
        response_id: 'resp-1',
        kind: 'survey',
        feedback_type: null,
        survey_id: 'nps_day14',
        score: 9,
        team_id: 'team-1',
        user_id: 'user-1',
        response: {
          reason: 'free text that must not leave the server',
          email: 'founder@example.com',
        },
        event_id: 'resp-1',
        received_at: '2026-11-19T10:00:00.000Z',
      },
    })
  )
  try {
    const status = await caller(AUTH).feedback.receipt({ responseId: 'resp-1' })
    assert.deepEqual(status, {
      response_id: 'resp-1',
      kind: 'survey',
      event: 'survey_completed',
      event_id: 'resp-1',
      received_at: '2026-11-19T10:00:00.000Z',
      score: 9,
    })
    // The raw answer object and the identifiers never reach the DTO.
    assert.deepEqual(Object.keys(status).sort(), [
      'event',
      'event_id',
      'kind',
      'received_at',
      'response_id',
      'score',
    ])
    const serialized = JSON.stringify(status)
    assert.equal(serialized.includes('founder@example.com'), false, 'email leaked into the DTO')
    assert.equal(serialized.includes('team-1'), false, 'team id leaked into the DTO')
    assert.equal(serialized.includes('user-1'), false, 'user id leaked into the DTO')
    assert.equal(serialized.includes('free text'), false, 'raw answers leaked into the DTO')
  } finally {
    restore()
  }
})

test('an unknown response_id answers NOT_FOUND', async () => {
  const restore = stubFetch(async () => jsonResponse({ error: 'Response not found' }, 404))
  try {
    await assert.rejects(
      () => caller(AUTH).feedback.receipt({ responseId: 'resp-missing' }),
      (error: unknown) => error instanceof TRPCError && error.code === 'NOT_FOUND'
    )
  } finally {
    restore()
  }
})

test('a malformed response_id is rejected before any backend call', async () => {
  let fetchCalls = 0
  const restore = stubFetch(async () => {
    fetchCalls += 1
    return jsonResponse({ item: {} })
  })
  try {
    await assert.rejects(
      () => caller(AUTH).feedback.receipt({ responseId: 'has space' }),
      (error: unknown) => error instanceof TRPCError && error.code === 'BAD_REQUEST'
    )
    assert.equal(fetchCalls, 0)
  } finally {
    restore()
  }
})