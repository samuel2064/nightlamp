import { describe, it, expect } from 'vitest'
import { buildBreakingChangeAlert, buildHealthSummaryAlert } from '../src/alerting/slack.js'

describe('buildBreakingChangeAlert', () => {
  it('returns danger color for critical severity', () => {
    const msg = buildBreakingChangeAlert('express', '4.0.0', '5.0.0', 'critical', ['Breaking API change'], 'Manual review required')
    expect(msg.attachments?.[0].color).toBe('danger')
  })

  it('returns warning color for high severity', () => {
    const msg = buildBreakingChangeAlert('lodash', '4.0.0', '5.0.0', 'high', ['Major bump'], 'Review carefully')
    expect(msg.attachments?.[0].color).toBe('warning')
  })

  it('returns good color for non-breaking', () => {
    const msg = buildBreakingChangeAlert('typescript', '4.9.0', '5.0.0', 'low', ['Minor update'], 'Safe to upgrade')
    expect(msg.attachments?.[0].color).toBe('good')
  })

  it('includes package name and versions in title', () => {
    const msg = buildBreakingChangeAlert('react', '17.0.0', '18.0.0', 'high', ['New renderer'], 'Migrate')
    expect(msg.attachments?.[0].title).toContain('react')
  })

  it('includes all fields', () => {
    const reasons = ['Breaking API change', 'Removed deprecated methods']
    const msg = buildBreakingChangeAlert('pkg', '1.0.0', '2.0.0', 'critical', reasons, 'Do not merge')
    const fields = msg.attachments?.[0].fields || []
    expect(fields.find(f => f.title === 'Severity')?.value).toBe('CRITICAL')
    expect(fields.find(f => f.title === 'Reasons')?.value).toBe(reasons.join('\n'))
    expect(fields.find(f => f.title === 'Recommendation')?.value).toBe('Do not merge')
  })

  it('includes footer and timestamp', () => {
    const msg = buildBreakingChangeAlert('pkg', '1.0.0', '2.0.0', 'low', [], 'ok')
    expect(msg.attachments?.[0].footer).toContain('Nightlamp')
    expect(msg.attachments?.[0].ts).toBeDefined()
  })
})

describe('buildHealthSummaryAlert', () => {
  it('uses danger for critical count > 0', () => {
    const msg = buildHealthSummaryAlert(10, 2, 0, 3)
    expect(msg.attachments?.[0].color).toBe('danger')
  })

  it('uses warning for high count > 0', () => {
    const msg = buildHealthSummaryAlert(10, 0, 3, 5)
    expect(msg.attachments?.[0].color).toBe('warning')
  })

  it('uses good for healthy', () => {
    const msg = buildHealthSummaryAlert(10, 0, 0, 0)
    expect(msg.attachments?.[0].color).toBe('good')
  })

  it('includes dependency counts', () => {
    const msg = buildHealthSummaryAlert(25, 1, 2, 5)
    const fields = msg.attachments?.[0].fields || []
    expect(fields.find(f => f.title === 'Total Tracked')?.value).toBe('25')
    expect(fields.find(f => f.title === 'Critical')?.value).toBe('1')
    expect(fields.find(f => f.title === 'High')?.value).toBe('2')
    expect(fields.find(f => f.title === 'Outdated')?.value).toBe('5')
  })
})