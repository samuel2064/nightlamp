import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'http'

const BASE_URL = process.env.SMOKE_TEST_URL || 'http://localhost:3000'
let server: Server | null = null

describe('smoke tests — deployed API contract', () => {
  beforeAll(async () => {
    if (process.env.SMOKE_TEST_URL) return
    const { default: app } = await import('../src/index.js')
    server = app.listen(0) as Server
    const addr = server.address()
    if (addr && typeof addr === 'object') {
      const port = addr.port
      process.env.SMOKE_TEST_URL = `http://localhost:${port}`
    }
  })

  afterAll(() => {
    server?.close()
  })

  it('GET /health returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'ok', service: 'nightlamp-backend' })
  })

  it('GET / returns 404 (no root route)', async () => {
    const res = await fetch(BASE_URL)
    expect(res.status).toBe(404)
  })

  it('POST /api/playbooks with missing body returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/playbooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('Missing required fields')
  })
})
