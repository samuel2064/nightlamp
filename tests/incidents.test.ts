import { describe, it, expect } from 'vitest'
import { getIncidents } from '../src/api/incidents.js'

describe('getIncidents', () => {
  it('returns 6 incidents', () => {
    expect(getIncidents()).toHaveLength(6)
  })

  it('all have required fields', () => {
    for (const inc of getIncidents()) {
      expect(inc.id).toMatch(/^INC-\d{3}$/)
      expect(inc.title).toBeTruthy()
      expect(inc.resource).toBeTruthy()
      expect(inc.severity).toMatch(/^(critical|high|medium|low)$/)
      expect(inc.status).toMatch(/^(open|investigating|resolved)$/)
      expect(inc.source).toBeTruthy()
    }
  })

  it('includes sentry-sourced incidents', () => {
    const sentryIncs = getIncidents().filter((i) => i.source === 'sentry')
    expect(sentryIncs.length).toBeGreaterThanOrEqual(1)
  })
})
