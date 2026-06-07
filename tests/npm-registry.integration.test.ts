import { describe, it, expect } from 'vitest'

describe.skip('npm registry integration (requires network)', () => {
  it('fetches real package info from npm', async () => {
    const { pollNpmRegistry } = await import('../src/connectors/npm-registry.js')
    const info = await pollNpmRegistry('express')
    expect(info.name).toBe('express')
    expect(info.latestVersion).toBeTruthy()
    expect(info.allVersions.length).toBeGreaterThan(0)
  }, 15000)

  it('fetches scoped package', async () => {
    const { pollNpmRegistry } = await import('../src/connectors/npm-registry.js')
    const info = await pollNpmRegistry('@types/node')
    expect(info.name).toBe('@types/node')
    expect(info.latestVersion).toBeTruthy()
  }, 15000)

  it('returns all versions', async () => {
    const { pollNpmRegistry } = await import('../src/connectors/npm-registry.js')
    const info = await pollNpmRegistry('lodash')
    expect(info.allVersions.length).toBeGreaterThan(50)
    expect(info.allVersions).toContain('4.17.21')
  }, 15000)

  it('throws on nonexistent package', async () => {
    const { pollNpmRegistry } = await import('../src/connectors/npm-registry.js')
    await expect(pollNpmRegistry('this-package-definitely-does-not-exist-12345')).rejects.toThrow()
  }, 15000)
})