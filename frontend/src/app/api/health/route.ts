import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'
const BACKEND_TIMEOUT_MS = 5000

export async function GET() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS)

  try {
    const res = await fetch(`${BACKEND_URL}/api/health`, {
      signal: controller.signal,
      cache: 'no-store',
    })
    const payload = await res.json().catch(() => null)

    return NextResponse.json(
      {
        ok: res.ok,
        frontend: 'up',
        backend: { reachable: res.ok, status: res.status, payload },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    )
  } catch {
    return NextResponse.json(
      {
        ok: false,
        frontend: 'up',
        backend: { reachable: false, status: null, payload: null },
        timestamp: new Date().toISOString(),
      },
      { status: 200 }
    )
  } finally {
    clearTimeout(timer)
  }
}
