import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { initDb, resetDb } from '../src/db.js'
import {
  createPlaybookEntry,
  getPlaybookEntry,
  getPlaybookEntries,
  getPlaybooksBySource,
  updatePlaybookStatus,
  deletePlaybookEntry,
  resetPlaybooks,
} from '../src/playbooks/playbook.js'
import {
  generatePlaybookEntry,
  registerPlaybookTemplate,
  getRegisteredFailureTypes,
} from '../src/playbooks/auto-generator.js'

describe('Playbook Database Layer (NOC-37 + NOC-46)', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetPlaybooks()
  })

  afterAll(() => {
    resetDb()
  })

  describe('createPlaybookEntry', () => {
    it('creates a new playbook entry', () => {
      const entry = createPlaybookEntry({
        failureType: 'dependency.breaking',
        source: 'npm-registry',
        severity: 'critical',
        title: 'Breaking change in express',
        description: 'express 4.x -> 5.x',
        affectedResource: 'express',
        diagnosis: 'Check semver diff',
        remediation: 'Update consuming code',
      })

      expect(entry.id).toBe(1)
      expect(entry.failureType).toBe('dependency.breaking')
      expect(entry.source).toBe('npm-registry')
      expect(entry.severity).toBe('critical')
      expect(entry.status).toBe('open')
      expect(entry.occurrenceCount).toBe(1)
      expect(entry.firstDetectedAt).toBeTruthy()
      expect(entry.lastDetectedAt).toBeTruthy()
    })

    it('increments occurrence count on duplicate failure_type + source', () => {
      const input = {
        failureType: 'dependency.breaking',
        source: 'npm-registry',
        severity: 'critical',
        title: 'Breaking change in express',
        description: 'express 4.x -> 5.x',
        affectedResource: 'express',
        diagnosis: 'Check semver diff',
        remediation: 'Update consuming code',
      }

      const first = createPlaybookEntry(input)
      const second = createPlaybookEntry(input)

      expect(second.occurrenceCount).toBe(2)
      expect(second.id).toBe(first.id)
    })
  })

  describe('getPlaybookEntry', () => {
    it('returns entry by id', () => {
      const created = createPlaybookEntry({
        failureType: 'integration.token.expired',
        source: 'token-manager',
        severity: 'critical',
        title: 'Token expired for Stripe',
        description: 'Stripe API token expired',
        affectedResource: 'stripe',
        diagnosis: 'Check token expiry',
        remediation: 'Generate new token',
      })

      const found = getPlaybookEntry(created.id!)
      expect(found).toBeTruthy()
      expect(found!.failureType).toBe('integration.token.expired')
    })

    it('returns undefined for missing entry', () => {
      expect(getPlaybookEntry(999)).toBeUndefined()
    })
  })

  describe('getPlaybookEntries', () => {
    it('returns all entries', () => {
      createPlaybookEntry({
        failureType: 'a', source: 's1', severity: 'high', title: 't1',
        description: '', affectedResource: 'r1', diagnosis: '', remediation: '',
      })
      createPlaybookEntry({
        failureType: 'b', source: 's2', severity: 'medium', title: 't2',
        description: '', affectedResource: 'r2', diagnosis: '', remediation: '',
      })

      expect(getPlaybookEntries()).toHaveLength(2)
    })

    it('filters by source', () => {
      createPlaybookEntry({
        failureType: 'a', source: 'npm', severity: 'high', title: 't1',
        description: '', affectedResource: 'r1', diagnosis: '', remediation: '',
      })
      createPlaybookEntry({
        failureType: 'b', source: 'webhook', severity: 'medium', title: 't2',
        description: '', affectedResource: 'r2', diagnosis: '', remediation: '',
      })

      const filtered = getPlaybookEntries({ source: 'npm' })
      expect(filtered).toHaveLength(1)
      expect(filtered[0].source).toBe('npm')
    })

    it('filters by severity', () => {
      createPlaybookEntry({
        failureType: 'a', source: 's1', severity: 'critical', title: 't1',
        description: '', affectedResource: 'r1', diagnosis: '', remediation: '',
      })
      createPlaybookEntry({
        failureType: 'b', source: 's2', severity: 'low', title: 't2',
        description: '', affectedResource: 'r2', diagnosis: '', remediation: '',
      })

      expect(getPlaybookEntries({ severity: 'critical' })).toHaveLength(1)
    })

    it('filters by status', () => {
      const input = {
        failureType: 'a', source: 's1', severity: 'high', title: 't1',
        description: '', affectedResource: 'r1', diagnosis: '', remediation: '',
      }
      const entry1 = createPlaybookEntry(input)
      createPlaybookEntry({ ...input, failureType: 'b' })
      updatePlaybookStatus(entry1.id!, 'resolved')

      expect(getPlaybookEntries({ status: 'open' })).toHaveLength(1)
      expect(getPlaybookEntries({ status: 'resolved' })).toHaveLength(1)
    })

    it('supports limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        createPlaybookEntry({
          failureType: `f${i}`, source: 's1', severity: 'low', title: `t${i}`,
          description: '', affectedResource: `r${i}`, diagnosis: '', remediation: '',
        })
      }

      const page = getPlaybookEntries({ limit: 2, offset: 1 })
      expect(page).toHaveLength(2)
    })
  })

  describe('getPlaybooksBySource', () => {
    it('returns entries for a specific source', () => {
      createPlaybookEntry({
        failureType: 'a', source: 'npm', severity: 'high', title: 't1',
        description: '', affectedResource: 'r1', diagnosis: '', remediation: '',
      })
      createPlaybookEntry({
        failureType: 'b', source: 'npm', severity: 'medium', title: 't2',
        description: '', affectedResource: 'r2', diagnosis: '', remediation: '',
      })
      createPlaybookEntry({
        failureType: 'c', source: 'webhook', severity: 'low', title: 't3',
        description: '', affectedResource: 'r3', diagnosis: '', remediation: '',
      })

      expect(getPlaybooksBySource('npm')).toHaveLength(2)
      expect(getPlaybooksBySource('webhook')).toHaveLength(1)
    })
  })

  describe('updatePlaybookStatus', () => {
    it('updates status to investigating', () => {
      const entry = createPlaybookEntry({
        failureType: 'test', source: 's1', severity: 'medium', title: 't',
        description: '', affectedResource: 'r', diagnosis: '', remediation: '',
      })

      const updated = updatePlaybookStatus(entry.id!, 'investigating')
      expect(updated!.status).toBe('investigating')
    })

    it('sets resolved_at when resolved', () => {
      const entry = createPlaybookEntry({
        failureType: 'test', source: 's1', severity: 'medium', title: 't',
        description: '', affectedResource: 'r', diagnosis: '', remediation: '',
      })

      const resolved = updatePlaybookStatus(entry.id!, 'resolved')
      expect(resolved!.status).toBe('resolved')
      expect(resolved!.resolvedAt).toBeTruthy()
    })

    it('returns undefined for non-existent entry', () => {
      expect(updatePlaybookStatus(999, 'resolved')).toBeUndefined()
    })
  })

  describe('deletePlaybookEntry', () => {
    it('deletes entry and returns true', () => {
      const entry = createPlaybookEntry({
        failureType: 'test', source: 's1', severity: 'low', title: 't',
        description: '', affectedResource: 'r', diagnosis: '', remediation: '',
      })

      expect(deletePlaybookEntry(entry.id!)).toBe(true)
      expect(getPlaybookEntry(entry.id!)).toBeUndefined()
    })

    it('returns false for non-existent entry', () => {
      expect(deletePlaybookEntry(999)).toBe(false)
    })
  })
})

describe('Playbook Auto-Generator (NOC-46)', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetPlaybooks()
  })

  afterAll(() => {
    resetDb()
  })

  describe('generatePlaybookEntry', () => {
    it('generates dependency.breaking entry', () => {
      const entry = generatePlaybookEntry('dependency.breaking', 'express', {
        fromVersion: '4.18.0',
        toVersion: '5.0.0',
        severity: 'critical',
        reason: 'Semver major bump',
      })

      expect(entry.failureType).toBe('dependency.breaking')
      expect(entry.severity).toBe('critical')
      expect(entry.title).toContain('express')
      expect(entry.diagnosis).toContain('semver')
      expect(entry.remediation).toContain('changelog')
      expect(entry.relatedEntries).toBe('dependency:express')
    })

    it('generates dependency.outdated entry', () => {
      const entry = generatePlaybookEntry('dependency.outdated', 'lodash', {
        fromVersion: '4.17.20',
        toVersion: '4.17.21',
        versionsBehind: '1',
      })

      expect(entry.failureType).toBe('dependency.outdated')
      expect(entry.severity).toBe('medium')
      expect(entry.affectedResource).toBe('lodash')
    })

    it('generates integration.webhook.failed entry', () => {
      const entry = generatePlaybookEntry('integration.webhook.failed', 'https://hooks.example.com', {
        status: '500',
        error: 'Internal server error',
      })

      expect(entry.failureType).toBe('integration.webhook.failed')
      expect(entry.severity).toBe('high')
      expect(entry.description).toContain('500')
    })

    it('generates integration.token.expired entry', () => {
      const entry = generatePlaybookEntry('integration.token.expired', 'stripe', {
        expiredAt: '2026-05-20T00:00:00Z',
      })

      expect(entry.failureType).toBe('integration.token.expired')
      expect(entry.severity).toBe('critical')
      expect(entry.remediation).toContain('Generate new token')
    })

    it('generates integration.rate-limit entry', () => {
      const entry = generatePlaybookEntry('integration.rate-limit', 'github-api', {
        limit: '60/hr',
        resetAt: '2026-05-26T00:00:00Z',
      })

      expect(entry.failureType).toBe('integration.rate-limit')
      expect(entry.severity).toBe('medium')
      expect(entry.remediation).toContain('backoff')
    })

    it('generates schema.drift entry', () => {
      const entry = generatePlaybookEntry('schema.drift', 'payment-service', {
        expectedField: 'amount_cents',
        receivedField: 'amount',
      })

      expect(entry.failureType).toBe('schema.drift')
      expect(entry.severity).toBe('high')
      expect(entry.diagnosis).toContain('Compare expected')
    })

    it('generates fallback for unknown failure type', () => {
      const entry = generatePlaybookEntry('unknown.failure', 'some-resource', {
        message: 'Something went wrong',
      })

      expect(entry.failureType).toBe('unknown.failure')
      expect(entry.severity).toBe('medium')
      expect(entry.diagnosis).toContain('No predefined diagnostic')
    })

    it('increments occurrence count on re-generation', () => {
      generatePlaybookEntry('dependency.breaking', 'express', { severity: 'critical' })
      const second = generatePlaybookEntry('dependency.breaking', 'express', { severity: 'critical' })

      expect(second.occurrenceCount).toBe(2)
    })
  })

  describe('registerPlaybookTemplate', () => {
    it('registers a custom template', () => {
      registerPlaybookTemplate('custom.failure', (resource, details) => ({
        failureType: 'custom.failure',
        source: 'custom-source',
        severity: 'low',
        title: `Custom failure on ${resource}`,
        description: details.message || '',
        affectedResource: resource,
        diagnosis: 'Custom diagnosis steps',
        remediation: 'Custom remediation steps',
      }))

      const entry = generatePlaybookEntry('custom.failure', 'my-service', { message: 'test' })
      expect(entry.title).toBe('Custom failure on my-service')
      expect(entry.diagnosis).toBe('Custom diagnosis steps')
    })
  })

  describe('getRegisteredFailureTypes', () => {
    it('returns all registered failure types', () => {
      const types = getRegisteredFailureTypes()
      expect(types).toContain('dependency.breaking')
      expect(types).toContain('dependency.outdated')
      expect(types).toContain('integration.webhook.failed')
      expect(types).toContain('integration.token.expired')
      expect(types).toContain('integration.rate-limit')
      expect(types).toContain('schema.drift')
    })
  })
})