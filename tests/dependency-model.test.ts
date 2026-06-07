import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { initDb, resetDb } from '../src/db.js'
import { resetStore, upsertDependency, getAllDependencies, getDependencyByName } from '../src/models/dependency.js'

describe('Dependency Model', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetStore()
  })

  afterAll(() => {
    resetDb()
  })

  describe('upsertDependency', () => {
    it('creates a new dependency', async () => {
      const dep = await upsertDependency({
        name: 'express',
        currentVersion: '4.18.0',
        latestVersion: '4.18.0',
        type: 'dependencies',
      })
      expect(dep.id).toBe(1)
      expect(dep.name).toBe('express')
      expect(dep.updatedAt).toBeTruthy()
    })

    it('updates existing dependency by name', async () => {
      const dep1 = await upsertDependency({
        name: 'express',
        currentVersion: '4.18.0',
        latestVersion: '4.18.0',
        type: 'dependencies',
      })
      const dep2 = await upsertDependency({
        name: 'express',
        currentVersion: '4.18.0',
        latestVersion: '5.0.0',
        type: 'dependencies',
      })
      expect(dep2.id).toBe(dep1.id)
      expect(dep2.latestVersion).toBe('5.0.0')
    })
  })

  describe('getAllDependencies', () => {
    it('returns all dependencies', async () => {
      await upsertDependency({ name: 'a', currentVersion: '1.0.0', latestVersion: '1.0.0', type: 'dependencies' })
      await upsertDependency({ name: 'b', currentVersion: '2.0.0', latestVersion: '2.0.0', type: 'devDependencies' })
      expect(getAllDependencies()).toHaveLength(2)
    })

    it('returns empty array when no dependencies', () => {
      expect(getAllDependencies()).toHaveLength(0)
    })
  })

  describe('getDependencyByName', () => {
    it('finds dependency by name', async () => {
      await upsertDependency({ name: 'lodash', currentVersion: '4.17.20', latestVersion: '4.17.21', type: 'dependencies' })
      const dep = getDependencyByName('lodash')
      expect(dep).toBeTruthy()
      expect(dep!.currentVersion).toBe('4.17.20')
    })

    it('returns undefined for missing dependency', () => {
      expect(getDependencyByName('nonexistent')).toBeUndefined()
    })
  })
})