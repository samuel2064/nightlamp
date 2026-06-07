import { describe, it, expect } from 'vitest'
import {
  classifyWebhookFailure,
  classifyTokenFailure,
  classifyRateLimitFailure,
  classifySchemaDrift,
  classifyMonitorDowntime,
  classifySslExpiry,
  classifySlowResponse,
  classifySentrySpike,
  classifySentryNewPattern,
} from '../src/analyzers/failure-classifier.js'

describe('classifyWebhookFailure', () => {
  it('classifies 5xx as critical', () => {
    const result = classifyWebhookFailure({ url: 'https://hooks.example.com', statusCode: 500 })
    expect(result.severity).toBe('critical')
    expect(result.title).toContain('Webhook delivery failed')
  })

  it('classifies 4xx as high', () => {
    const result = classifyWebhookFailure({ url: 'https://hooks.example.com', statusCode: 401 })
    expect(result.severity).toBe('high')
  })

  it('classifies slow response as medium', () => {
    const result = classifyWebhookFailure({ url: 'https://hooks.example.com', responseTimeMs: 15000 })
    expect(result.severity).toBe('medium')
    expect(result.details.responseTimeMs).toBe('15000')
  })

  it('classifies many retries as medium', () => {
    const result = classifyWebhookFailure({ url: 'https://hooks.example.com', retryAttempts: 5, statusCode: 503 })
    expect(result.severity).toBe('critical')
  })

  it('classifies minor failure as low', () => {
    const result = classifyWebhookFailure({ url: 'https://hooks.example.com', statusCode: 200, responseTimeMs: 500 })
    expect(result.severity).toBe('low')
  })

  it('includes error message in description', () => {
    const result = classifyWebhookFailure({ url: 'https://hooks.example.com', statusCode: 500, error: 'Connection refused' })
    expect(result.description).toContain('Connection refused')
  })
})

describe('classifyTokenFailure', () => {
  it('classifies expired production token as critical', () => {
    const result = classifyTokenFailure({
      service: 'stripe',
      expiredAt: new Date(Date.now() - 86400000 * 2).toISOString(),
      isProduction: true,
    })
    expect(result.severity).toBe('critical')
    expect(result.title).toContain('stripe')
    expect(result.description).toContain('[PRODUCTION]')
  })

  it('classifies expired non-production token as high', () => {
    const result = classifyTokenFailure({
      service: 'stripe',
      expiredAt: new Date(Date.now() - 86400000).toISOString(),
    })
    expect(result.severity).toBe('high')
  })

  it('classifies soon-to-expire token as medium', () => {
    const future = new Date(Date.now() + 86400000 * 5).toISOString()
    const result = classifyTokenFailure({ service: 'github', expiredAt: future })
    expect(result.severity).toBe('medium')
  })

  it('handles daysSinceExpiry directly', () => {
    const result = classifyTokenFailure({ service: 'test', daysSinceExpiry: 10 })
    expect(result.severity).toBe('high')
  })
})

describe('classifyRateLimitFailure', () => {
  it('classifies 95%+ as critical', () => {
    const result = classifyRateLimitFailure({ service: 'github-api', limit: 100, remaining: 2 })
    expect(result.severity).toBe('critical')
    expect(result.details.usagePercent).toBe('98')
  })

  it('classifies 80-94% as high', () => {
    const result = classifyRateLimitFailure({ service: 'github-api', limit: 100, remaining: 15 })
    expect(result.severity).toBe('high')
  })

  it('classifies increasing trend as medium', () => {
    const result = classifyRateLimitFailure({
      service: 'github-api', limit: 100, remaining: 60, recentTrend: 'increasing',
    })
    expect(result.severity).toBe('medium')
  })

  it('classifies low usage as low', () => {
    const result = classifyRateLimitFailure({ service: 'github-api', limit: 100, remaining: 90 })
    expect(result.severity).toBe('low')
  })
})

describe('classifySchemaDrift', () => {
  it('classifies removed field as critical', () => {
    const result = classifySchemaDrift({
      service: 'payment-service',
      expectedSchema: 'v2',
      receivedSchema: 'v3',
      changedFields: ['amount'],
      changeType: 'field_removed',
    })
    expect(result.severity).toBe('critical')
  })

  it('classifies required field as high', () => {
    const result = classifySchemaDrift({
      service: 'payment-service',
      expectedSchema: 'v2',
      receivedSchema: 'v3',
      changedFields: ['currency'],
      changeType: 'field_required',
    })
    expect(result.severity).toBe('high')
  })

  it('classifies type changed as high', () => {
    const result = classifySchemaDrift({
      service: 'payment-service',
      expectedSchema: 'v2',
      receivedSchema: 'v3',
      changedFields: ['amount'],
      changeType: 'field_type_changed',
    })
    expect(result.severity).toBe('high')
  })

  it('classifies new field as low', () => {
    const result = classifySchemaDrift({
      service: 'payment-service',
      expectedSchema: 'v2',
      receivedSchema: 'v3',
      changedFields: ['discount'],
      changeType: 'field_added',
    })
    expect(result.severity).toBe('low')
  })

  it('classifies multiple changes as medium', () => {
    const result = classifySchemaDrift({
      service: 'payment-service',
      expectedSchema: 'v2',
      receivedSchema: 'v3',
      changedFields: ['amount', 'currency'],
      changeType: 'multiple',
    })
    expect(result.severity).toBe('medium')
  })
})

describe('classifyMonitorDowntime', () => {
  it('classifies extended downtime as critical', () => {
    const result = classifyMonitorDowntime({
      monitorName: 'API Production',
      monitorUrl: 'https://api.example.com',
      durationMinutes: 120,
      currentStatus: 'down',
      uptimeRatio: 90,
    })
    expect(result.severity).toBe('critical')
  })

  it('classifies moderate downtime as high', () => {
    const result = classifyMonitorDowntime({
      monitorName: 'API Production',
      monitorUrl: 'https://api.example.com',
      durationMinutes: 20,
      currentStatus: 'down',
      uptimeRatio: 99.5,
    })
    expect(result.severity).toBe('high')
  })

  it('classifies brief downtime as medium', () => {
    const result = classifyMonitorDowntime({
      monitorName: 'API Production',
      monitorUrl: 'https://api.example.com',
      durationMinutes: 2,
      currentStatus: 'seems_down',
      uptimeRatio: 99.9,
    })
    expect(result.severity).toBe('medium')
  })
})

describe('classifySslExpiry', () => {
  it('classifies expired as critical', () => {
    const result = classifySslExpiry({
      monitorName: 'example.com',
      monitorUrl: 'https://example.com',
      sslStatus: 'expired',
      daysRemaining: 0,
    })
    expect(result.severity).toBe('critical')
    expect(result.title).toContain('expired')
  })

  it('classifies 7 days as high', () => {
    const result = classifySslExpiry({
      monitorName: 'example.com',
      monitorUrl: 'https://example.com',
      sslStatus: 'valid',
      daysRemaining: 5,
    })
    expect(result.severity).toBe('high')
  })

  it('classifies 30 days as medium', () => {
    const result = classifySslExpiry({
      monitorName: 'example.com',
      monitorUrl: 'https://example.com',
      sslStatus: 'valid',
      daysRemaining: 20,
    })
    expect(result.severity).toBe('medium')
  })

  it('classifies >30 days as low', () => {
    const result = classifySslExpiry({
      monitorName: 'example.com',
      monitorUrl: 'https://example.com',
      sslStatus: 'valid',
      daysRemaining: 90,
    })
    expect(result.severity).toBe('low')
  })
})

describe('classifySlowResponse', () => {
  it('classifies 3x threshold as high', () => {
    const result = classifySlowResponse({
      monitorName: 'API',
      monitorUrl: 'https://api.example.com',
      responseTimeMs: 20000,
      thresholdMs: 5000,
    })
    expect(result.severity).toBe('high')
  })

  it('classifies 1.5x threshold as medium', () => {
    const result = classifySlowResponse({
      monitorName: 'API',
      monitorUrl: 'https://api.example.com',
      responseTimeMs: 9000,
      thresholdMs: 5000,
    })
    expect(result.severity).toBe('medium')
  })

  it('classifies slight excess as low', () => {
    const result = classifySlowResponse({
      monitorName: 'API',
      monitorUrl: 'https://api.example.com',
      responseTimeMs: 6000,
      thresholdMs: 5000,
    })
    expect(result.severity).toBe('low')
  })
})

describe('classifySentrySpike', () => {
  it('classifies 10x spike as critical', () => {
    const result = classifySentrySpike({
      project: 'web-app',
      currentVolume: 1000,
      baselineVolume: 50,
      multiplier: 20,
      topErrors: [{ title: 'TypeError', count: 500 }],
    })
    expect(result.severity).toBe('critical')
  })

  it('classifies 5x spike as high', () => {
    const result = classifySentrySpike({
      project: 'web-app',
      currentVolume: 500,
      baselineVolume: 100,
      multiplier: 5,
      topErrors: [{ title: 'ReferenceError', count: 300 }],
    })
    expect(result.severity).toBe('high')
  })

  it('classifies moderate spike as medium', () => {
    const result = classifySentrySpike({
      project: 'web-app',
      currentVolume: 150,
      baselineVolume: 100,
      multiplier: 1.5,
      topErrors: [{ title: 'Warning', count: 50 }],
    })
    expect(result.severity).toBe('medium')
  })
})

describe('classifySentryNewPattern', () => {
  it('classifies fatal as critical', () => {
    const result = classifySentryNewPattern({
      project: 'web-app',
      errorTitle: 'OutOfMemory',
      errorLevel: 'fatal',
      firstSeen: '2026-06-01T00:00:00Z',
      errorCount: 1,
    })
    expect(result.severity).toBe('critical')
  })

  it('classifies high count error as high', () => {
    const result = classifySentryNewPattern({
      project: 'web-app',
      errorTitle: 'TypeError: x is undefined',
      errorLevel: 'error',
      firstSeen: '2026-06-01T00:00:00Z',
      errorCount: 200,
    })
    expect(result.severity).toBe('high')
  })

  it('classifies low count warning as medium', () => {
    const result = classifySentryNewPattern({
      project: 'web-app',
      errorTitle: 'DeprecationWarning',
      errorLevel: 'warning',
      firstSeen: '2026-06-01T00:00:00Z',
      errorCount: 5,
    })
    expect(result.severity).toBe('medium')
  })
})
