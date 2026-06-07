import { describe, it, expect } from 'vitest'
import {
  detectErrorSpike,
  detectNewErrorPatterns,
  buildSentryHeaders,
} from '../src/connectors/sentry.js'
import type { SentryError } from '../src/connectors/sentry.js'

describe('buildSentryHeaders', () => {
  it('returns auth headers', () => {
    const headers = buildSentryHeaders({
      org: 'test-org',
      project: 'test-proj',
      authToken: 'tok_abc123',
    })
    expect(headers.Authorization).toBe('Bearer tok_abc123')
    expect(headers['Content-Type']).toBe('application/json')
  })
})

describe('detectErrorSpike', () => {
  const makeError = (overrides: Partial<SentryError> = {}): SentryError => ({
    id: '1',
    title: 'TypeError: x is undefined',
    culprit: 'app/services/user',
    level: 'error',
    count: 10,
    userCount: 5,
    firstSeen: '2026-05-01T00:00:00Z',
    lastSeen: '2026-06-01T00:00:00Z',
    permalink: 'https://sentry.io/test-org/test-proj/issues/1/',
    ...overrides,
  })

  it('returns spike when volume exceeds threshold', () => {
    const errors = [
      makeError({ count: 100 }),
      makeError({ id: '2', title: 'RangeError', count: 80 }),
      makeError({ id: '3', title: 'SyntaxError', count: 60 }),
    ]

    const spike = detectErrorSpike(errors, 50, 2)
    expect(spike).not.toBeNull()
    expect(spike!.multiplier).toBeGreaterThanOrEqual(4)
    expect(spike!.currentVolume).toBe(240)
    expect(spike!.baselineVolume).toBe(50)
  })

  it('returns null when volume is below threshold', () => {
    const errors = [makeError({ count: 5 }), makeError({ id: '2', count: 3 })]
    const spike = detectErrorSpike(errors, 100, 2)
    expect(spike).toBeNull()
  })

  it('handles empty errors array', () => {
    const spike = detectErrorSpike([], 10)
    expect(spike).toBeNull()
  })

  it('handles zero baseline', () => {
    const errors = [makeError({ count: 10 })]
    const spike = detectErrorSpike(errors, 0, 2)
    expect(spike).toBeNull()
  })

  it('includes spike errors that exceed average', () => {
    const errors = [
      makeError({ count: 200 }),
      makeError({ id: '2', count: 5 }),
      makeError({ id: '3', count: 2 }),
    ]

    const spike = detectErrorSpike(errors, 30, 2)
    expect(spike).not.toBeNull()
    expect(spike!.errors.length).toBeGreaterThanOrEqual(1)
  })
})

describe('detectNewErrorPatterns', () => {
  const makeError = (id: string): SentryError => ({
    id,
    title: `Error ${id}`,
    culprit: 'app/services/checkout',
    level: 'error',
    count: 1,
    userCount: 1,
    firstSeen: '2026-06-01T00:00:00Z',
    lastSeen: '2026-06-01T00:00:00Z',
    permalink: `https://sentry.io/org/proj/issues/${id}/`,
  })

  it('detects new patterns not in known set', () => {
    const current = [makeError('1'), makeError('2'), makeError('3')]
    const known = new Set(['1'])
    const newPatterns = detectNewErrorPatterns(current, known)

    expect(newPatterns).toHaveLength(2)
    expect(newPatterns.map((p) => p.error.id)).toEqual(['2', '3'])
  })

  it('returns empty when all patterns are known', () => {
    const current = [makeError('1'), makeError('2')]
    const known = new Set(['1', '2'])
    expect(detectNewErrorPatterns(current, known)).toHaveLength(0)
  })

  it('returns empty for empty current errors', () => {
    expect(detectNewErrorPatterns([], new Set())).toHaveLength(0)
  })
})
