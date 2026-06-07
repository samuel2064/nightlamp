import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { initDb, resetDb } from '../src/db.js'
import { resetPlaybooks } from '../src/playbooks/playbook.js'
import {
  writeFailureToPlaybook,
  writeFailuresToPlaybook,
  isKnownPattern,
  getKnownPattern,
  getKnownPatterns,
  resetKnownPatterns,
  getFailureReport,
} from '../src/playbooks/failure-writer.js'
import { classifyWebhookFailure, classifyTokenFailure } from '../src/analyzers/failure-classifier.js'

describe('Failure Writer (NOC-46)', () => {
  beforeAll(async () => {
    await initDb(':memory:')
  })

  beforeEach(() => {
    resetPlaybooks()
    resetKnownPatterns()
  })

  afterAll(() => {
    resetDb()
  })

  describe('writeFailureToPlaybook', () => {
    it('creates a new playbook entry from classification', () => {
      const classification = classifyWebhookFailure({
        url: 'https://hooks.example.com',
        statusCode: 500,
      })

      const { entry, isNew } = writeFailureToPlaybook(classification)

      expect(isNew).toBe(true)
      expect(entry.id).toBeTruthy()
      expect(entry.failureType).toBe('integration.webhook.failed')
      expect(entry.source).toBe('webhook')
      expect(entry.severity).toBe('critical')
      expect(entry.status).toBe('open')
      expect(entry.occurrenceCount).toBe(1)
    })

    it('returns isNew=false on duplicate detection', () => {
      const classification = classifyWebhookFailure({
        url: 'https://hooks.example.com',
        statusCode: 500,
      })

      writeFailureToPlaybook(classification)
      const { isNew } = writeFailureToPlaybook(classification)

      expect(isNew).toBe(false)
    })

    it('tracks known patterns in memory', () => {
      const classification = classifyTokenFailure({
        service: 'stripe',
        expiredAt: new Date(Date.now() - 86400000).toISOString(),
      })

      writeFailureToPlaybook(classification)

      expect(isKnownPattern('integration.token.expired', 'stripe')).toBe(true)
      const pattern = getKnownPattern('integration.token.expired', 'stripe')
      expect(pattern).toBeTruthy()
      expect(pattern!.occurrenceCount).toBe(1)
    })

    it('increments occurrence count on re-detection', () => {
      const classification = classifyWebhookFailure({
        url: 'https://hooks.example.com',
        statusCode: 502,
      })

      writeFailureToPlaybook(classification)
      writeFailureToPlaybook(classification)

      const pattern = getKnownPattern('integration.webhook.failed', 'https://hooks.example.com')
      expect(pattern!.occurrenceCount).toBe(2)
    })

    it('creates playbook entry for monitor downtime', () => {
      const classification = {
        failureType: 'monitor.downtime' as const,
        resource: 'API Production',
        severity: 'critical' as const,
        title: 'Monitor down: API Production',
        description: 'API Production down for 30 minutes',
        diagnosis: 'Check server logs',
        remediation: 'Restart service',
        details: { durationMinutes: '30' },
      }

      const { entry, isNew } = writeFailureToPlaybook(classification)
      expect(isNew).toBe(true)
      expect(entry.failureType).toBe('monitor.downtime')
      expect(entry.source).toBe('uptime-robot')
      expect(entry.severity).toBe('critical')
    })

    it('creates playbook entry for sentry error spike', () => {
      const classification = {
        failureType: 'sentry.error-spike' as const,
        resource: 'web-app',
        severity: 'high' as const,
        title: 'Error spike: web-app',
        description: '5x error spike in web-app',
        diagnosis: 'Review Sentry',
        remediation: 'Roll back deploy',
        details: { multiplier: '5' },
      }

      const { entry, isNew } = writeFailureToPlaybook(classification)
      expect(isNew).toBe(true)
      expect(entry.failureType).toBe('sentry.error-spike')
      expect(entry.source).toBe('sentry')
    })
  })

  describe('writeFailuresToPlaybook', () => {
    it('writes multiple classifications', () => {
      const results = writeFailuresToPlaybook([
        classifyWebhookFailure({ url: 'https://a.com', statusCode: 500 }),
        classifyTokenFailure({ service: 'stripe', expiredAt: new Date().toISOString() }),
      ])

      expect(results).toHaveLength(2)
      expect(results[0].isNew).toBe(true)
      expect(results[1].isNew).toBe(true)
    })
  })

  describe('getKnownPatterns', () => {
    it('returns all known patterns', () => {
      writeFailureToPlaybook(
        classifyWebhookFailure({ url: 'https://a.com', statusCode: 500 }),
      )
      writeFailureToPlaybook(
        classifyTokenFailure({ service: 'stripe', expiredAt: new Date().toISOString() }),
      )

      const patterns = getKnownPatterns()
      expect(patterns).toHaveLength(2)
    })

    it('returns empty when no patterns exist', () => {
      expect(getKnownPatterns()).toHaveLength(0)
    })
  })

  describe('getFailureReport', () => {
    it('returns report from playbook entries', () => {
      writeFailureToPlaybook(
        classifyWebhookFailure({ url: 'https://a.com', statusCode: 500 }),
      )

      const report = getFailureReport()
      expect(report.length).toBeGreaterThanOrEqual(1)
      expect(report[0].playbookEntry).toBeTruthy()
    })
  })
})
