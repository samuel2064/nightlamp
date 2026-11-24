// Bounded backend request timeout (NOC-340 remediation): a hung backend can
// never leave a request pending forever, and an aborted request is classified
// as an ambiguous timeout rather than a definitive failure. The happy path and
// the error passthrough keep working.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BackendTimeoutError, createBackendClient } from '../src/server/services/backend.ts'

type FetchStub = (url: string, init?: RequestInit) => Promise<Response>

function stubFetch(stub: FetchStub): () => void {
  const original = globalThis.fetch
  globalThis.fetch = stub as unknown as typeof globalThis.fetch
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

test('a request that exceeds the deadline aborts into a typed timeout', async () => {
  let seenSignal: AbortSignal | undefined
  const restore = stubFetch((_url, init) => {
    seenSignal = init?.signal as AbortSignal | undefined
    // Never settles: only the abort can end this request.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })
  })
  try {
    process.env.BACKEND_REQUEST_TIMEOUT_MS = '30'
    const client = createBackendClient('token-1')
    await assert.rejects(
      () => client.health.get(),
      (error: unknown) => {
        assert.ok(error instanceof BackendTimeoutError)
        assert.equal((error as BackendTimeoutError).kind, 'timeout')
        return true
      }
    )
    assert.ok(seenSignal, 'the request carries the abort signal')
    assert.equal(seenSignal.aborted, true)
  } finally {
    delete process.env.BACKEND_REQUEST_TIMEOUT_MS
    restore()
  }
})

test('a fast response still resolves', async () => {
  const restore = stubFetch(async (url) => {
    assert.match(String(url), /\/api\/health$/)
    return jsonResponse({ status: 'ok', stats: {}, timestamp: '2026-11-19T10:00:00.000Z' })
  })
  try {
    const client = createBackendClient('token-1')
    const health = await client.health.get()
    assert.equal(health.status, 'healthy')
  } finally {
    restore()
  }
})

test('a non-2xx response keeps the backend error shape', async () => {
  const restore = stubFetch(async () =>
    jsonResponse({ error: 'Event not found' }, 404)
  )
  try {
    const client = createBackendClient('token-1')
    await assert.rejects(
      () => client.events.acknowledge('evt-1'),
      /Backend API error 404/
    )
  } finally {
    restore()
  }
})

test('the acknowledgement is posted with the bearer token and the event id', async () => {
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
    const client = createBackendClient('token-1')
    const acked = await client.events.acknowledge('evt-1')
    assert.deepEqual(acked, { success: true, id: 'evt-1' })
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/api\/events\/acknowledge$/)
    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, { id: 'evt-1' })
    assert.equal(calls[0].auth, 'Bearer token-1')
  } finally {
    restore()
  }
})