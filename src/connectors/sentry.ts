export interface SentryConfig {
  org: string
  project: string
  authToken: string
  baseUrl?: string
}

export interface SentryError {
  id: string
  title: string
  culprit: string
  level: string
  count: number
  userCount: number
  firstSeen: string
  lastSeen: string
  permalink: string
  status?: string
  isNew?: boolean
}

export interface SentryErrorSpike {
  project: string
  currentVolume: number
  baselineVolume: number
  multiplier: number
  errors: SentryError[]
  detectedAt: string
}

export interface SentryNewPattern {
  project: string
  error: SentryError
  firstSeen: string
  detectedAt: string
}

const SENTRY_API_BASE = 'https://sentry.io/api/0'

export function buildSentryHeaders(config: SentryConfig): Record<string, string> {
  return {
    Authorization: `Bearer ${config.authToken}`,
    'Content-Type': 'application/json',
  }
}

export async function pollSentryErrors(
  config: SentryConfig,
  options?: { statsPeriod?: string; limit?: number },
): Promise<SentryError[]> {
  const base = config.baseUrl || SENTRY_API_BASE
  const org = encodeURIComponent(config.org)
  const proj = encodeURIComponent(config.project)
  const statsPeriod = options?.statsPeriod || '24h'
  const limit = options?.limit || 100

  const url = `${base}/projects/${org}/${proj}/issues/?statsPeriod=${statsPeriod}&limit=${limit}&query=is:unresolved`
  const res = await fetch(url, { headers: buildSentryHeaders(config) })

  if (!res.ok) {
    throw new Error(`Sentry API returned ${res.status} for ${config.org}/${config.project}`)
  }

  const data = await res.json() as Array<{
    id: string
    title: string
    culprit: string
    level: string
    count: number
    userCount: number
    firstSeen: string
    lastSeen: string
    permalink: string
    status: string
    isNew?: boolean
  }>

  return data.map((issue) => ({
    id: issue.id,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    count: issue.count,
    userCount: issue.userCount,
    firstSeen: issue.firstSeen,
    lastSeen: issue.lastSeen,
    permalink: issue.permalink,
    status: issue.status,
    isNew: issue.isNew,
  }))
}

export function detectErrorSpike(
  currentErrors: SentryError[],
  baselineCount: number,
  spikeThreshold: number = 2,
): SentryErrorSpike | null {
  const currentVolume = currentErrors.reduce((sum, e) => sum + e.count, 0)
  const multiplier = baselineCount > 0 ? currentVolume / baselineCount : 0

  if (multiplier < spikeThreshold) return null

  const spikeErrors = currentErrors.filter((e) => e.count > baselineCount / Math.max(currentErrors.length, 1))

  return {
    project: currentErrors[0]?.culprit?.split(' ')[0] || 'unknown',
    currentVolume,
    baselineVolume: baselineCount,
    multiplier: Math.round(multiplier * 100) / 100,
    errors: spikeErrors,
    detectedAt: new Date().toISOString(),
  }
}

export function detectNewErrorPatterns(
  currentErrors: SentryError[],
  knownPatterns: Set<string>,
): SentryNewPattern[] {
  const newPatterns: SentryNewPattern[] = []
  const now = new Date().toISOString()

  for (const error of currentErrors) {
    if (!knownPatterns.has(error.id)) {
      newPatterns.push({
        project: error.culprit?.split(' ')[0] || 'unknown',
        error,
        firstSeen: error.firstSeen,
        detectedAt: now,
      })
    }
  }

  return newPatterns
}
