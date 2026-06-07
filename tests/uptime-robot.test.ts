import { describe, it, expect } from 'vitest'
import { MonitorStatusLabel } from '../src/connectors/uptime-robot.js'

describe('MonitorStatusLabel', () => {
  it('maps all status codes', () => {
    expect(MonitorStatusLabel[0]).toBe('paused')
    expect(MonitorStatusLabel[1]).toBe('not_checked_yet')
    expect(MonitorStatusLabel[2]).toBe('up')
    expect(MonitorStatusLabel[8]).toBe('seems_down')
    expect(MonitorStatusLabel[9]).toBe('down')
  })

  it('returns unknown for invalid code', () => {
    expect(MonitorStatusLabel[99 as 0]).toBeUndefined()
  })
})
