import { describe, it, expect } from 'vitest'
import { evaluatePreShipGate, formatPrComment } from '../src/alerting/pre-ship-gate.js'
import type { ClassifiedChange } from '../src/analyzers/severity-classifier.js'

function makeChange(pkg: string, severity: 'critical' | 'high' | 'medium' | 'low' | 'none', reason?: string): ClassifiedChange {
  return {
    packageName: pkg,
    fromVersion: '1.0.0',
    toVersion: '2.0.0',
    severity,
    semverDiff: { type: 'major', from: { major: 1, minor: 0, patch: 0 }, to: { major: 2, minor: 0, patch: 0 }, description: 'Major' },
    reasons: reason ? [reason] : ['Change detected'],
    recommendation: 'Review',
  }
}

describe('evaluatePreShipGate', () => {
  it('blocks on critical changes', () => {
    const result = evaluatePreShipGate([makeChange('express', 'critical', 'Breaking API change')])
    expect(result.passed).toBe(false)
    expect(result.blockingChanges).toHaveLength(1)
    expect(result.summary).toContain('Blocked')
  })

  it('passes with warning on high severity', () => {
    const result = evaluatePreShipGate([makeChange('lodash', 'high')])
    expect(result.passed).toBe(true)
    expect(result.warnings).toHaveLength(1)
    expect(result.summary).toContain('Warning')
  })

  it('passes cleanly with low severity', () => {
    const result = evaluatePreShipGate([makeChange('typescript', 'low')])
    expect(result.passed).toBe(true)
    expect(result.summary).toContain('safe')
  })

  it('blocks on critical even with mixed changes', () => {
    const result = evaluatePreShipGate([
      makeChange('express', 'critical'),
      makeChange('lodash', 'high'),
      makeChange('react', 'medium'),
    ])
    expect(result.passed).toBe(false)
    expect(result.blockingChanges).toHaveLength(1)
    expect(result.warnings).toHaveLength(2)
  })

  it('handles empty changes', () => {
    const result = evaluatePreShipGate([])
    expect(result.passed).toBe(true)
    expect(result.summary).toContain('safe')
    expect(result.blockingChanges).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })
})

describe('formatPrComment', () => {
  it('includes blocking changes section', () => {
    const result = evaluatePreShipGate([makeChange('express', 'critical')])
    const comment = formatPrComment(result)
    expect(comment).toContain('🚫 Blocking')
    expect(comment).toContain('express')
  })

  it('includes warnings section', () => {
    const result = evaluatePreShipGate([makeChange('lodash', 'high')])
    const comment = formatPrComment(result)
    expect(comment).toContain('⚠️ Warnings')
    expect(comment).toContain('lodash')
  })

  it('includes footer', () => {
    const result = evaluatePreShipGate([])
    const comment = formatPrComment(result)
    expect(comment).toContain('Nightlamp Dependency Monitor')
  })
})