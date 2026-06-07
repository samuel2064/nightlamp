import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { initDb, resetDb } from '../src/db.js'
import { getDependencyHealth } from '../src/api/dependency-health.js'
import { resetStore, upsertDependency } from '../src/models/dependency.js'

describe('getDependencyHealth', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetStore()
  })

  afterAll(() => {
    resetDb()
  })

  it('returns empty health when no dependencies', () => {
    const health = getDependencyHealth()
    expect(health.total).toBe(0)
    expect(health.upToDate).toBe(0)
    expect(health.outdated).toBe(0)
  })

  it('counts dependencies by type', async () => {
    await upsertDependency({ name: 'express', currentVersion: '4.18.0', latestVersion: '4.18.0', type: 'dependencies' })
    await upsertDependency({ name: 'vitest', currentVersion: '1.0.0', latestVersion: '1.0.0', type: 'devDependencies' })
    await upsertDependency({ name: 'react', currentVersion: '18.0.0', latestVersion: '18.0.0', type: 'peerDependencies' })

    const health = getDependencyHealth()
    expect(health.total).toBe(3)
    expect(health.byType.dependencies).toBe(1)
    expect(health.byType.devDependencies).toBe(1)
    expect(health.byType.peerDependencies).toBe(1)
  })

  it('counts up-to-date vs outdated', async () => {
    await upsertDependency({ name: 'up-to-date', currentVersion: '1.0.0', latestVersion: '1.0.0', type: 'dependencies' })
    await upsertDependency({ name: 'outdated', currentVersion: '1.0.0', latestVersion: '2.0.0', type: 'dependencies' })

    const health = getDependencyHealth()
    expect(health.upToDate).toBe(1)
    expect(health.outdated).toBe(1)
  })

  it('includes lastChecked timestamp', async () => {
    await upsertDependency({ name: 'test', currentVersion: '1.0.0', latestVersion: '1.0.0', type: 'dependencies' })

    const health = getDependencyHealth()
    expect(health.lastChecked).toBeTruthy()
  })

  it('respects maxCriticalItems option', () => {
    const health = getDependencyHealth({ maxCriticalItems: 5 })
    expect(health).toBeDefined()
  })
})