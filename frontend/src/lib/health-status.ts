// Health status derivation (NOC-195 UX QA round 1).
//
// RULE: a green ("healthy") state must never coexist with a non-zero critical
// counter. The UI always derives status worst-of from the live counters —
// the stored backend field is treated as a secondary signal. When the stored
// field disagrees with the derivation (e.g. backend says "healthy" while
// Critical (24h) > 0), the UI shows the derived severity plus a
// "check data incomplete" note instead of a green badge.

export type HealthLevel = 'healthy' | 'degraded' | 'critical'

interface HealthStatsInput {
  criticalLast24h?: number
  incidentsLast24h?: number
  failureEvents?: number
}

interface HealthSloInput {
  errorRate24h?: number
}

export interface HealthInput {
  status?: string
  stats?: HealthStatsInput
  slo?: HealthSloInput
}

const DEGRADED_ERROR_RATE_PCT = 1

/** Backend may return a fraction (0.02) or a percentage (99.9); normalize to %. */
export function normalizeErrorRatePct(value: number | undefined | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value > 1 ? value : value * 100
}

export interface DerivedHealthStatus {
  status: HealthLevel
  /** Stored backend status says healthy while derived counters disagree. */
  inconsistent: boolean
}

export function deriveHealthStatus(health: HealthInput | null | undefined): DerivedHealthStatus {
  const critical = health?.stats?.criticalLast24h ?? 0
  const incidents = health?.stats?.incidentsLast24h ?? 0
  const errorRatePct = normalizeErrorRatePct(health?.slo?.errorRate24h)

  let derived: HealthLevel = 'healthy'
  if (incidents > 0 || (errorRatePct !== null && errorRatePct > DEGRADED_ERROR_RATE_PCT)) {
    derived = 'degraded'
  }
  if (critical > 0) {
    derived = 'critical'
  }

  return {
    status: derived,
    inconsistent: health?.status === 'healthy' && derived !== 'healthy',
  }
}

const LEVEL_VARIANT = {
  healthy: 'success',
  degraded: 'warning',
  critical: 'destructive',
} as const

export function healthLevelVariant(level: HealthLevel) {
  return LEVEL_VARIANT[level]
}
