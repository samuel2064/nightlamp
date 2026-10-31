import { NextResponse } from 'next/server'

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function fail(error: string, status: number) {
  return NextResponse.json({ error }, { status })
}

/**
 * Same-origin bridge for webinar registrations.
 *
 * The backend (`POST /api/leads`) sets `Access-Control-Allow-Origin: *` but does
 * not answer CORS preflights, so a direct browser POST with a JSON content type
 * is blocked. Proxying through this route keeps the browser request same-origin
 * and forwards the backend's status/body unchanged so the form can distinguish
 * success, duplicate (409) and validation (400) responses.
 */
export async function POST(request: Request) {
  let payload: { email?: unknown; name?: unknown }
  try {
    payload = (await request.json()) as { email?: unknown; name?: unknown }
  } catch {
    return fail('Invalid JSON body', 400)
  }

  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : ''
  if (!email) return fail('email is required', 400)
  if (!EMAIL_REGEX.test(email)) return fail('email must be a valid email address', 400)

  const body: Record<string, string> = { email, source: 'webinar' }
  if (typeof payload.name === 'string' && payload.name.trim()) {
    body.name = payload.name.trim()
  }

  try {
    const upstream = await fetch(`${BACKEND_URL}/api/leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })

    const text = await upstream.text()
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      },
    })
  } catch {
    return fail('Could not reach the registration service. Please try again.', 502)
  }
}
