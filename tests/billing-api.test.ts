import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { initDb, resetDb } from '../src/db.js'
import { createCustomer, upsertSubscription } from '../src/billing/repository.js'
import billingRoutes from '../src/billing/routes.js'

describe('billing API integration', () => {
  let server: Server
  let baseUrl: string

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_mock'
    resetDb()
    await initDb(':memory:')

    const app = express()
    app.use(express.json())
    app.use('/api/billing', billingRoutes)

    const customer = createCustomer('cus_int', 'int@example.com', 'Int User')
    upsertSubscription('sub_int', customer.id, 'respond', 'active', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`
        }
        resolve()
      })
    })
  })

  afterAll(() => {
    server?.close()
    resetDb()
    delete process.env.STRIPE_SECRET_KEY
  })

  it('GET /api/billing/subscription returns subscription data', async () => {
    const res = await fetch(`${baseUrl}/api/billing/subscription?email=int@example.com`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.plan_tier).toBe('respond')
    expect(data.status).toBe('active')
  })

  it('GET /api/billing/subscription returns 400 without email', async () => {
    const res = await fetch(`${baseUrl}/api/billing/subscription`)
    expect(res.status).toBe(400)
  })

  it('GET /api/billing/subscription returns 404 for unknown email', async () => {
    const res = await fetch(`${baseUrl}/api/billing/subscription?email=nobody@example.com`)
    expect(res.status).toBe(404)
  })

  it('GET /api/billing/usage returns usage data', async () => {
    const res = await fetch(`${baseUrl}/api/billing/usage?email=int@example.com`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.monitors_used).toBe(0)
  })

  it('POST /api/billing/create-checkout-session returns 400 without body', async () => {
    const res = await fetch(`${baseUrl}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/billing/create-checkout-session returns 400 for invalid tier', async () => {
    const res = await fetch(`${baseUrl}/api/billing/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@test.com', planTier: 'invalid' }),
    })
    expect(res.status).toBe(400)
  })
})