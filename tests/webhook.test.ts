import { describe, it, expect } from 'vitest'
import { buildDependencyChangePayload, buildHealthCheckPayload } from '../src/alerting/webhook.js'

describe('buildDependencyChangePayload', () => {
  it('builds a breaking change payload', () => {
    const payload = buildDependencyChangePayload('express', '4.0.0', '5.0.0', 'critical', ['Breaking API change'])
    expect(payload.event).toBe('dependency.change')
    expect(payload.data.package).toBe('express')
    expect(payload.data.fromVersion).toBe('4.0.0')
    expect(payload.data.toVersion).toBe('5.0.0')
    expect(payload.data.changeType).toBe('breaking')
  })

  it('builds non-breaking payload', () => {
    const payload = buildDependencyChangePayload('lodash', '4.17.20', '4.17.21', 'low', ['Patch fix'])
    expect(payload.data.changeType).toBe('non-breaking')
  })

  it('includes timestamp', () => {
    const payload = buildDependencyChangePayload('pkg', '1.0.0', '1.0.1', 'low', [])
    expect(payload.timestamp).toBeTruthy()
    expect(() => new Date(payload.timestamp)).not.toThrow()
  })
})

describe('buildHealthCheckPayload', () => {
  it('builds health check payload with counts', () => {
    const payload = buildHealthCheckPayload(20, 1, 2, 3, 4)
    expect(payload.event).toBe('dependency.health')
    expect(payload.data.totalDependencies).toBe(20)
    expect(payload.data.bySeverity.critical).toBe(1)
    expect(payload.data.bySeverity.high).toBe(2)
    expect(payload.data.healthy).toBe(10)
  })

  it('handles all zeros', () => {
    const payload = buildHealthCheckPayload(0, 0, 0, 0, 0)
    expect(payload.data.totalDependencies).toBe(0)
    expect(payload.data.healthy).toBe(0)
  })
})