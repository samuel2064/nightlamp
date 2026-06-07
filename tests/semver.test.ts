import { describe, it, expect } from 'vitest'
import { parseSemver, compareSemver, isBreakingChange } from '../src/analyzers/semver.js'

describe('parseSemver', () => {
  it('parses standard semver', () => {
    const v = parseSemver('1.2.3')
    expect(v).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('parses prerelease semver', () => {
    const v = parseSemver('2.0.0-beta.1')
    expect(v?.major).toBe(2)
    expect(v?.prerelease).toBe('beta.1')
  })

  it('parses build metadata', () => {
    const v = parseSemver('1.0.0+build.42')
    expect(v?.build).toBe('build.42')
  })

  it('parses prerelease with build', () => {
    const v = parseSemver('1.0.0-alpha+sha.abc123')
    expect(v?.prerelease).toBe('alpha')
    expect(v?.build).toBe('sha.abc123')
  })

  it('returns null for invalid version', () => {
    expect(parseSemver('not-a-version')).toBeNull()
    expect(parseSemver('v1.2.3')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })

  it('handles zero versions', () => {
    const v = parseSemver('0.0.0')
    expect(v).toEqual({ major: 0, minor: 0, patch: 0 })
  })
})

describe('compareSemver', () => {
  it('detects major bump', () => {
    const diff = compareSemver('1.0.0', '2.0.0')
    expect(diff.type).toBe('major')
    expect(diff.description).toContain('Major bump')
  })

  it('detects minor bump', () => {
    const diff = compareSemver('1.0.0', '1.1.0')
    expect(diff.type).toBe('minor')
  })

  it('detects patch bump', () => {
    const diff = compareSemver('1.0.0', '1.0.1')
    expect(diff.type).toBe('patch')
  })

  it('detects no change', () => {
    const diff = compareSemver('1.2.3', '1.2.3')
    expect(diff.type).toBe('no_change')
  })

  it('detects downgrade', () => {
    const diff = compareSemver('2.0.0', '1.0.0')
    expect(diff.type).toBe('downgrade')
  })

  it('detects prerelease to release as minor', () => {
    const diff = compareSemver('1.0.0-beta', '1.0.0')
    expect(diff.type).toBe('minor')
  })

  it('detects release to prerelease', () => {
    const diff = compareSemver('1.0.0', '1.0.0-beta')
    expect(diff.type).toBe('prerelease')
  })

  it('detects prerelease change', () => {
    const diff = compareSemver('1.0.0-alpha', '1.0.0-beta')
    expect(diff.type).toBe('prerelease')
  })

  it('handles 0.x major version bumps', () => {
    const diff = compareSemver('0.1.0', '0.2.0')
    expect(diff.type).toBe('minor')
  })

  it('handles string versions', () => {
    const diff = compareSemver('3.2.1', '4.0.0')
    expect(diff.type).toBe('major')
  })
})

describe('isBreakingChange', () => {
  it('returns true for major bump', () => {
    expect(isBreakingChange(compareSemver('1.0.0', '2.0.0'))).toBe(true)
  })

  it('returns true for minor bump in 0.x', () => {
    const diff = compareSemver('0.1.0', '0.2.0')
    // 0.2.0 minor bump from 0.1.0 — 0.x minor bumps can be breaking
    expect(isBreakingChange(diff)).toBe(true)
  })

  it('returns false for minor bump in 1.x', () => {
    expect(isBreakingChange(compareSemver('1.0.0', '1.1.0'))).toBe(false)
  })

  it('returns false for patch bump', () => {
    expect(isBreakingChange(compareSemver('1.0.0', '1.0.1'))).toBe(false)
  })
})