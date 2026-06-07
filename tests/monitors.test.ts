import { describe, it, expect } from 'vitest'
import { getMonitors } from '../src/api/monitors.js'

describe('getMonitors', () => {
  it('returns 6 monitors', () => {
    const result = getMonitors()
    expect(result.monitors).toHaveLength(6)
  })

  it('includes all expected services', () => {
    const names = getMonitors().monitors.map((m) => m.friendlyName)
    expect(names).toContain('Production API')
    expect(names).toContain('Web App')
    expect(names).toContain('Database')
    expect(names).toContain('Worker Queue')
    expect(names).toContain('Billing Service')
    expect(names).toContain('CDN')
  })

  it('overall status is not down', () => {
    const result = getMonitors()
    expect(result.overallStatus).not.toBe('down')
  })

  it('each monitor has required fields', () => {
    for (const m of getMonitors().monitors) {
      expect(m.id).toBeGreaterThan(0)
      expect(m.friendlyName).toBeTruthy()
      expect(m.status).toMatch(/^(up|degraded|down)$/)
      expect(typeof m.uptimeRatio).toBe('number')
      expect(typeof m.responseTime).toBe('number')
      expect(m.lastChecked).toBeTruthy()
    }
  })
})
