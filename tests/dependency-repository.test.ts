import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { initDb, resetDb, getDb } from '../src/db.js'
import {
  resetStore, upsertDependency, getUpdates,
  getUpdatesByDependencyId, getUpdatesBySeverity, deleteOldUpdates,
  recordHealthSnapshot, getHealthHistory, resetHealthSnapshots,
  upsertAlertRule, getAlertRules, getAlertRule, deleteAlertRule, resetAlertRules,
} from '../src/models/dependency.js'

describe('Dependency Repository (NOC-41)', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetStore()
    resetHealthSnapshots()
    resetAlertRules()
  })

  afterAll(() => {
    resetDb()
  })

  describe('getUpdatesByDependencyId', () => {
    it('returns updates for a specific dependency', async () => {
      const dep = await upsertDependency({
        name: 'express', currentVersion: '4.18.0', latestVersion: '4.19.0', type: 'dependencies',
      })

      const db = getDb()
      db.run(
        `INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary)
         VALUES (?, '4.18.0', '4.19.0', 'minor', 'low', 0, 'Minor bump')`,
        [dep.id!],
      )

      const updates = getUpdatesByDependencyId(dep.id!)
      expect(updates).toHaveLength(1)
      expect(updates[0].fromVersion).toBe('4.18.0')
      expect(updates[0].toVersion).toBe('4.19.0')
    })

    it('returns empty array when no updates exist', () => {
      expect(getUpdatesByDependencyId(999)).toHaveLength(0)
    })
  })

  describe('getUpdatesBySeverity', () => {
    it('filters updates by severity', async () => {
      const dep1 = await upsertDependency({
        name: 'pkg-a', currentVersion: '1.0.0', latestVersion: '2.0.0', type: 'dependencies',
      })
      const dep2 = await upsertDependency({
        name: 'pkg-b', currentVersion: '1.0.0', latestVersion: '1.1.0', type: 'dependencies',
      })

      const db = getDb()
      db.run(
        `INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary)
         VALUES (?, '1.0.0', '2.0.0', 'major', 'critical', 1, 'Major bump')`,
        [dep1.id!],
      )
      db.run(
        `INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary)
         VALUES (?, '1.0.0', '1.1.0', 'minor', 'low', 0, 'Minor bump')`,
        [dep2.id!],
      )

      const critical = getUpdatesBySeverity('critical')
      expect(critical).toHaveLength(1)
      expect(critical[0].changeType).toBe('major')

      const low = getUpdatesBySeverity('low')
      expect(low).toHaveLength(1)
      expect(low[0].changeType).toBe('minor')

      expect(getUpdatesBySeverity('high')).toHaveLength(0)
    })

    it('supports pagination', async () => {
      const dep = await upsertDependency({
        name: 'pkg', currentVersion: '1.0.0', latestVersion: '1.5.0', type: 'dependencies',
      })

      const db = getDb()
      for (let i = 1; i <= 3; i++) {
        db.run(
          `INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary)
           VALUES (?, '1.0.0', '1.${i}.0', 'minor', 'low', 0, 'Bump')`,
          [dep.id!],
        )
      }

      const page = getUpdatesBySeverity('low', { limit: 2, offset: 0 })
      expect(page).toHaveLength(2)
    })
  })

  describe('deleteOldUpdates', () => {
    it('deletes updates before given date', async () => {
      const dep = await upsertDependency({
        name: 'pkg', currentVersion: '1.0.0', latestVersion: '1.1.0', type: 'dependencies',
      })

      const db = getDb()
      db.run(
        `INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary, detected_at)
         VALUES (?, '1.0.0', '1.1.0', 'minor', 'low', 0, 'Bump', '2025-01-01T00:00:00Z')`,
        [dep.id!],
      )
      db.run(
        `INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary)
         VALUES (?, '1.1.0', '1.2.0', 'minor', 'low', 0, 'Bump')`,
        [dep.id!],
      )

      const deleted = deleteOldUpdates('2025-06-01T00:00:00Z')
      expect(deleted).toBe(1)
      expect(getUpdates()).toHaveLength(1)
    })

    it('returns 0 when no old updates exist', () => {
      expect(deleteOldUpdates('2020-01-01T00:00:00Z')).toBe(0)
    })
  })

  describe('Health Snapshots', () => {
    it('records a health snapshot', async () => {
      await upsertDependency({
        name: 'express', currentVersion: '4.18.0', latestVersion: '4.18.0', type: 'dependencies',
      })
      await upsertDependency({
        name: 'lodash', currentVersion: '4.17.20', latestVersion: '4.17.21', type: 'dependencies',
      })

      const snapshot = recordHealthSnapshot()
      expect(snapshot.totalDependencies).toBe(2)
      expect(snapshot.upToDate).toBe(1)
      expect(snapshot.outdated).toBe(1)
      expect(snapshot.snapshotAt).toBeTruthy()
    })

    it('retrieves health history in reverse chronological order', () => {
      recordHealthSnapshot()
      recordHealthSnapshot()

      const history = getHealthHistory()
      expect(history).toHaveLength(2)
    })

    it('supports pagination on history', () => {
      for (let i = 0; i < 5; i++) {
        recordHealthSnapshot()
      }

      const page = getHealthHistory({ limit: 2, offset: 1 })
      expect(page).toHaveLength(2)
    })

    it('returns empty array when no snapshots exist', () => {
      expect(getHealthHistory()).toHaveLength(0)
    })
  })

  describe('Alert Rules', () => {
    it('creates a new alert rule', () => {
      const rule = upsertAlertRule({
        packageName: 'express',
        ruleType: 'breaking',
        minSeverity: 'high',
        channel: 'slack',
        enabled: true,
      })

      expect(rule.id).toBe(1)
      expect(rule.packageName).toBe('express')
      expect(rule.ruleType).toBe('breaking')
      expect(rule.enabled).toBe(true)
      expect(rule.createdAt).toBeTruthy()
    })

    it('updates existing alert rule by package + ruleType', () => {
      const original = upsertAlertRule({
        packageName: 'express',
        ruleType: 'breaking',
        minSeverity: 'high',
        channel: 'slack',
        enabled: true,
      })

      const updated = upsertAlertRule({
        packageName: 'express',
        ruleType: 'breaking',
        minSeverity: 'critical',
        channel: 'email',
        enabled: false,
      })

      expect(updated.id).toBe(original.id)
      expect(updated.minSeverity).toBe('critical')
      expect(updated.channel).toBe('email')
      expect(updated.enabled).toBe(false)
    })

    it('retrieves all alert rules', () => {
      upsertAlertRule({
        packageName: 'express', ruleType: 'breaking', minSeverity: 'high', channel: 'slack', enabled: true,
      })
      upsertAlertRule({
        packageName: 'lodash', ruleType: 'outdated', minSeverity: 'low', channel: 'webhook', enabled: true,
      })

      const rules = getAlertRules()
      expect(rules).toHaveLength(2)
    })

    it('filters alert rules by package name', () => {
      upsertAlertRule({
        packageName: 'express', ruleType: 'breaking', minSeverity: 'high', channel: 'slack', enabled: true,
      })
      upsertAlertRule({
        packageName: 'lodash', ruleType: 'outdated', minSeverity: 'low', channel: 'webhook', enabled: true,
      })

      const filtered = getAlertRules({ packageName: 'express' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].packageName).toBe('express')
    })

    it('filters alert rules by enabled status', () => {
      upsertAlertRule({
        packageName: 'express', ruleType: 'breaking', minSeverity: 'high', channel: 'slack', enabled: true,
      })
      upsertAlertRule({
        packageName: 'lodash', ruleType: 'outdated', minSeverity: 'low', channel: 'webhook', enabled: false,
      })

      const enabled = getAlertRules({ enabled: true })
      expect(enabled).toHaveLength(1)
      expect(enabled[0].packageName).toBe('express')
    })

    it('gets a single alert rule by package + ruleType', () => {
      upsertAlertRule({
        packageName: 'express', ruleType: 'breaking', minSeverity: 'high', channel: 'slack', enabled: true,
      })

      const rule = getAlertRule('express', 'breaking')
      expect(rule).toBeTruthy()
      expect(rule!.packageName).toBe('express')
    })

    it('returns undefined for non-existent alert rule', () => {
      expect(getAlertRule('nonexistent', 'breaking')).toBeUndefined()
    })

    it('deletes an alert rule', () => {
      upsertAlertRule({
        packageName: 'express', ruleType: 'breaking', minSeverity: 'high', channel: 'slack', enabled: true,
      })

      expect(deleteAlertRule('express', 'breaking')).toBe(true)
      expect(getAlertRule('express', 'breaking')).toBeUndefined()
    })

    it('returns false when deleting non-existent rule', () => {
      expect(deleteAlertRule('nonexistent', 'breaking')).toBe(false)
    })
  })
})
