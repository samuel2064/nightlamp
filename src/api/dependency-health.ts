import { getAllDependencies, getUpdates, getDependencyByName } from '../models/dependency.js'
import { compareSemver } from '../analyzers/semver.js'
import type { ChangeSeverity } from '../analyzers/severity-classifier.js'

export interface DependencyHealth {
  total: number
  upToDate: number
  outdated: number
  bySeverity: Record<ChangeSeverity, number>
  byType: {
    dependencies: number
    devDependencies: number
    peerDependencies: number
  }
  criticalItems: Array<{
    name: string
    currentVersion: string
    latestVersion: string
    severity: ChangeSeverity
    summary: string
  }>
  recentUpdates: number
  lastChecked?: string
}

export interface HealthCheckOptions {
  maxCriticalItems?: number
}

export function getDependencyHealth(options?: HealthCheckOptions): DependencyHealth {
  const deps = getAllDependencies()
  const updates = getUpdates({ breakingOnly: false, limit: 100 })

  const bySeverity: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, none: 0 }
  const byType = { dependencies: 0, devDependencies: 0, peerDependencies: 0 }

  let upToDate = 0
  let outdated = 0

  for (const dep of deps) {
    byType[dep.type] = (byType[dep.type] || 0) + 1

    if (dep.currentVersion === dep.latestVersion) {
      upToDate++
    } else {
      outdated++
    }
  }

  const criticalItems: DependencyHealth['criticalItems'] = []
  const maxItems = options?.maxCriticalItems ?? 10

  for (const update of updates) {
    if (!update.breaking) continue
    const dep = getDependencyByName(
      deps.find(d => d.id === update.dependencyId)?.name ?? '',
    )
    if (!dep) continue

    const severity: ChangeSeverity = update.severity === 'high' ? 'high' : update.severity === 'low' ? 'low' : 'medium'
    bySeverity[severity] = (bySeverity[severity] || 0) + 1

    if (criticalItems.length < maxItems && (severity as string) === 'critical' || severity === 'high') {
      criticalItems.push({
        name: dep.name,
        currentVersion: update.fromVersion,
        latestVersion: update.toVersion,
        severity,
        summary: update.summary,
      })
    }
  }

  const sortedDeps = [...deps]
  const lastChecked = sortedDeps.length > 0
    ? sortedDeps.reduce((latest, d) => d.updatedAt && d.updatedAt > latest ? d.updatedAt : latest, sortedDeps[0].updatedAt || '')
    : undefined

  return {
    total: deps.length,
    upToDate,
    outdated,
    bySeverity: bySeverity as Record<ChangeSeverity, number>,
    byType,
    criticalItems,
    recentUpdates: updates.length,
    lastChecked,
  }
}