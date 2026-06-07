import { describe, it, expect } from 'vitest'
import { classifyChange } from '../src/analyzers/severity-classifier.js'
import { compareSemver } from '../src/analyzers/semver.js'
import type { ChangelogEntry } from '../src/analyzers/changelog-parser.js'

describe('classifyChange', () => {
  it('classifies critical for major with breaking changelog on stable package', () => {
    const diff = compareSemver('1.0.0', '2.0.0')
    const changelog: ChangelogEntry = {
      version: '2.0.0',
      date: '2024-06-01',
      sections: { breaking_changes: ['Removed v1 API'] },
      breakingChanges: ['Removed v1 API'],
    }
    const result = classifyChange('express', '1.0.0', '2.0.0', diff, changelog)
    expect(result.severity).toBe('critical')
    expect(result.reasons.some(r => r.includes('Major semver bump on stable'))).toBe(true)
    expect(result.recommendation).toContain('Blocking')
  })

  it('classifies critical for 0.x to 1.0 with breaking changelog', () => {
    const diff = compareSemver('0.1.0', '1.0.0')
    const changelog: ChangelogEntry = {
      version: '1.0.0',
      date: undefined,
      sections: { breaking_changes: ['API changes'] },
      breakingChanges: ['API changes'],
    }
    const result = classifyChange('alpha-pkg', '0.1.0', '1.0.0', diff, changelog)
    expect(result.severity).toBe('critical')
  })

  it('classifies high for major on direct dependency even without changelog', () => {
    const diff = compareSemver('1.0.0', '2.0.0')
    const result = classifyChange('lodash', '1.0.0', '2.0.0', diff, undefined, {
      isDirectDependency: true,
    })
    expect(result.severity).toBe('high')
    expect(result.reasons.some(r => r.includes('direct dependency'))).toBe(true)
  })

  it('classifies medium for major on transitive dependency', () => {
    const diff = compareSemver('1.0.0', '2.0.0')
    const result = classifyChange('some-pkg', '1.0.0', '2.0.0', diff)
    expect(result.severity).toBe('medium')
  })

  it('classifies high for minor bump with breaking changes', () => {
    const diff = compareSemver('1.0.0', '1.1.0')
    const changelog: ChangelogEntry = {
      version: '1.1.0',
      date: undefined,
      sections: { changed: ['Breaking change to config format'] },
      breakingChanges: ['Breaking change to config format'],
    }
    const result = classifyChange('config-lib', '1.0.0', '1.1.0', diff, changelog)
    expect(result.severity).toBe('high')
  })

  it('classifies medium for minor bump on pre-v1', () => {
    const diff = compareSemver('0.1.0', '0.2.0')
    const result = classifyChange('unstable-pkg', '0.1.0', '0.2.0', diff)
    expect(result.severity).toBe('medium')
  })

  it('classifies low for normal minor bump', () => {
    const diff = compareSemver('1.0.0', '1.1.0')
    const result = classifyChange('stable-pkg', '1.0.0', '1.1.0', diff)
    expect(result.severity).toBe('low')
  })

  it('classifies high for patch with breaking changes', () => {
    const diff = compareSemver('1.0.0', '1.0.1')
    const changelog: ChangelogEntry = {
      version: '1.0.1',
      date: undefined,
      sections: { fixed: ['Breaking change that fixes security issue'] },
      breakingChanges: ['Breaking change that fixes security issue'],
    }
    const result = classifyChange('security-lib', '1.0.0', '1.0.1', diff, changelog)
    expect(result.severity).toBe('high')
  })

  it('classifies low for normal patch without breaking', () => {
    const diff = compareSemver('1.0.0', '1.0.1')
    const result = classifyChange('stable-pkg', '1.0.0', '1.0.1', diff)
    expect(result.severity).toBe('low')
  })

  it('classifies none for no change', () => {
    const diff = compareSemver('1.0.0', '1.0.0')
    const result = classifyChange('pkg', '1.0.0', '1.0.0', diff)
    expect(result.severity).toBe('none')
  })

  it('classifies medium for downgrade', () => {
    const diff = compareSemver('2.0.0', '1.0.0')
    const result = classifyChange('pkg', '2.0.0', '1.0.0', diff)
    expect(result.severity).toBe('medium')
  })

  it('includes package name in result', () => {
    const diff = compareSemver('1.0.0', '2.0.0')
    const result = classifyChange('react', '1.0.0', '2.0.0', diff)
    expect(result.packageName).toBe('react')
    expect(result.fromVersion).toBe('1.0.0')
    expect(result.toVersion).toBe('2.0.0')
  })

  it('provides appropriate recommendation text', () => {
    const diff = compareSemver('1.0.0', '2.0.0')
    const result = classifyChange('lib', '1.0.0', '2.0.0', diff, undefined, {
      isDirectDependency: true,
    })
    expect(result.recommendation).toBeTruthy()
    expect(result.recommendation.length).toBeGreaterThan(10)
  })
})