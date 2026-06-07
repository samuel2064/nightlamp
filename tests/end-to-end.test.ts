import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { initDb, resetDb } from '../src/db.js'
import { compareSemver, isBreakingChange, parseSemver } from '../src/analyzers/semver.js'
import { parseChangelog, parseConventionalCommit } from '../src/analyzers/changelog-parser.js'
import { classifyChange } from '../src/analyzers/severity-classifier.js'
import { resetStore, upsertDependency, getAllDependencies, getUpdates } from '../src/models/dependency.js'

describe('end-to-end dependency check pipeline', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetStore()
  })

  afterAll(() => {
    resetDb()
  })

  it('pipeline: semver -> changelog -> severity', () => {
    const fromVersion = '1.0.0'
    const toVersion = '2.0.0'

    const diff = compareSemver(fromVersion, toVersion)
    expect(diff.type).toBe('major')
    expect(isBreakingChange(diff)).toBe(true)

    const changelog = parseChangelog(`## [2.0.0] - 2024-06-01

### Breaking Changes
- Removed deprecated v1 API
- Changed authentication flow

### Added
- New v2 API`)

    expect(changelog).toHaveLength(1)
    expect(changelog[0].breakingChanges).toHaveLength(2)

    const classified = classifyChange('express', fromVersion, toVersion, diff, changelog[0], { isDirectDependency: true })
    expect(classified.severity).toBe('critical')
    expect(classified.reasons.length).toBeGreaterThanOrEqual(2)
    expect(classified.recommendation).toContain('Blocking')
  })

  it('pipeline: conventional commit parsing extracts breaking', () => {
    const commits = [
      parseConventionalCommit('feat: add new endpoint')!,
      parseConventionalCommit('feat!: drop v1 support')!,
      parseConventionalCommit('fix(auth)!: require OAuth2')!,
      parseConventionalCommit('chore: bump deps')!,
    ]

    const breakingCommits = commits.filter(c => c.breaking)
    expect(breakingCommits).toHaveLength(2)
    expect(breakingCommits[0].description).toBe('drop v1 support')
    expect(breakingCommits[1].scope).toBe('auth')
  })

  it('handles prerelease versions end-to-end', () => {
    const v1 = parseSemver('2.0.0-beta.1')!
    const v2 = parseSemver('2.0.0')!

    const diff = compareSemver(v1, v2)
    expect(diff.type).toBe('minor')
    expect(isBreakingChange(diff)).toBe(false)
  })

  it('produces consistent severity across severity levels', () => {
    const testCases = [
      { from: '1.0.0', to: '2.0.0', breaking: true, direct: true, expected: 'critical' },
      { from: '1.0.0', to: '2.0.0', breaking: false, direct: true, expected: 'high' },
      { from: '1.0.0', to: '2.0.0', breaking: false, direct: false, expected: 'medium' },
      { from: '1.0.0', to: '1.1.0', breaking: false, direct: false, expected: 'low' },
      { from: '1.0.0', to: '1.0.1', breaking: false, direct: false, expected: 'low' },
      { from: '0.1.0', to: '0.2.0', breaking: false, direct: false, expected: 'medium' },
    ]

    for (const tc of testCases) {
      const diff = compareSemver(tc.from, tc.to)
      const changelog = tc.breaking
        ? { version: tc.to, date: undefined, sections: { breaking_changes: ['Test breaking'] }, breakingChanges: ['Test breaking'] }
        : undefined
      const result = classifyChange('pkg', tc.from, tc.to, diff, changelog, { isDirectDependency: tc.direct })
      expect(result.severity).toBe(tc.expected as never)
    }
  })

  describe.skip('network-dependent (requires npm registry)', () => {
    it('parses a real-world package.json and detects updates', async () => {
      const { runDependencyCheck } = await import('../src/models/dependency.js')
      const packageJson = JSON.stringify({
        name: 'test-app',
        version: '1.0.0',
        dependencies: {
          express: '^4.18.0',
          lodash: '^4.17.20',
        },
      })

      const result = await runDependencyCheck(packageJson)
      expect(result.deps.length).toBeGreaterThanOrEqual(1)
      expect(result.classified.length).toBeGreaterThanOrEqual(0)

      const dep = getAllDependencies()
      expect(dep.length).toBeGreaterThanOrEqual(1)
      expect(dep.some(d => d.name === 'express')).toBe(true)
    }, 30000)
  })
})