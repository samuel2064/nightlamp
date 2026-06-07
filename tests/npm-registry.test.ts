import { describe, it, expect } from 'vitest'
import { parsePackageJson, extractDependencies, resolveRangeToVersion } from '../src/connectors/npm-registry.js'

describe('parsePackageJson', () => {
  it('parses valid package.json', () => {
    const pkg = parsePackageJson('{"name": "test", "version": "1.0.0"}')
    expect(pkg.name).toBe('test')
    expect(pkg.version).toBe('1.0.0')
  })

  it('throws on invalid JSON', () => {
    expect(() => parsePackageJson('not json')).toThrow('Invalid package.json')
  })

  it('parses package.json with dependencies', () => {
    const pkg = parsePackageJson(JSON.stringify({
      name: 'test',
      dependencies: { express: '^4.18.0' },
      devDependencies: { vitest: '^1.0.0' },
    }))
    expect(pkg.dependencies?.express).toBe('^4.18.0')
    expect(pkg.devDependencies?.vitest).toBe('^1.0.0')
  })

  it('handles empty object', () => {
    const pkg = parsePackageJson('{}')
    expect(pkg.name).toBeUndefined()
  })
})

describe('extractDependencies', () => {
  it('extracts all dependency types', () => {
    const deps = extractDependencies({
      name: 'test',
      dependencies: { express: '^4.18.0' },
      devDependencies: { vitest: '^1.0.0' },
      peerDependencies: { react: '^18.0.0' },
    })
    expect(deps).toHaveLength(3)
    expect(deps.find(d => d.name === 'express')?.type).toBe('dependencies')
    expect(deps.find(d => d.name === 'vitest')?.type).toBe('devDependencies')
    expect(deps.find(d => d.name === 'react')?.type).toBe('peerDependencies')
  })

  it('handles missing dependency sections', () => {
    const deps = extractDependencies({ name: 'test' })
    expect(deps).toHaveLength(0)
  })
})

describe('resolveRangeToVersion', () => {
  it('resolves caret range', () => {
    expect(resolveRangeToVersion('^4.18.0')).toBe('4.18.0')
  })

  it('resolves tilde range', () => {
    expect(resolveRangeToVersion('~1.2.3')).toBe('1.2.3')
  })

  it('resolves exact version', () => {
    expect(resolveRangeToVersion('1.0.0')).toBe('1.0.0')
  })

  it('returns null for non-parseable range', () => {
    expect(resolveRangeToVersion('*')).toBeNull()
    expect(resolveRangeToVersion('latest')).toBeNull()
    expect(resolveRangeToVersion('')).toBeNull()
  })
})