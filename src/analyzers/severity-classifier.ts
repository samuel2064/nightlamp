import type { ChangelogEntry } from './changelog-parser.js'
import type { SemverDiff } from './semver.js'

export type ChangeSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none'

export interface ClassifiedChange {
  packageName: string
  fromVersion: string
  toVersion: string
  severity: ChangeSeverity
  semverDiff: SemverDiff
  changelogAnalysis?: {
    hasBreakingChanges: boolean
    breakingReasons: string[]
  }
  reasons: string[]
  recommendation: string
}

export interface ClassificationOptions {
  isDirectDependency?: boolean
  isDevDependency?: boolean
  hasTestCoverage?: boolean
}

const STABLE_MAJOR_THRESHOLD = 1

export function classifyChange(
  packageName: string,
  fromVersion: string,
  toVersion: string,
  semverDiff: SemverDiff,
  changelogEntry?: ChangelogEntry,
  options?: ClassificationOptions,
): ClassifiedChange {
  const reasons: string[] = []
  let severity: ChangeSeverity = 'none'
  const changelogAnalysis = changelogEntry ? analyzeChangelogImpact(changelogEntry) : undefined

  if (semverDiff.type === 'downgrade') {
    severity = 'medium'
    reasons.push(semverDiff.description)
  }

  if (semverDiff.type === 'major') {
    if (changelogAnalysis?.hasBreakingChanges) {
      if (semverDiff.to.major >= STABLE_MAJOR_THRESHOLD) {
        severity = 'critical'
        reasons.push(`Major semver bump on stable package (v${fromVersion} → v${toVersion})`)
      } else {
        severity = 'high'
        reasons.push(`Major semver bump (v${fromVersion} → v${toVersion})`)
      }
      reasons.push(...changelogAnalysis.breakingReasons)
    } else if (options?.isDirectDependency) {
      severity = 'high'
      reasons.push(`Major semver bump on direct dependency (v${fromVersion} → v${toVersion})`)
    } else {
      severity = 'medium'
      reasons.push(`Major semver bump (v${fromVersion} → v${toVersion})`)
    }
  }

  if (semverDiff.type === 'minor') {
    if (changelogAnalysis?.hasBreakingChanges) {
      severity = compareSeverity(severity, 'high')
      reasons.push(`Minor bump with breaking changes (v${fromVersion} → v${toVersion})`)
      reasons.push(...changelogAnalysis.breakingReasons)
    } else if (semverDiff.to.major === 0) {
      severity = compareSeverity(severity, 'medium')
      reasons.push(`Minor bump on pre-v1 package — may contain breaking changes (v${fromVersion} → v${toVersion})`)
    } else {
      severity = compareSeverity(severity, 'low')
      reasons.push(`Minor bump (v${fromVersion} → v${toVersion})`)
    }
  }

  if (semverDiff.type === 'patch') {
    if (changelogAnalysis?.hasBreakingChanges) {
      severity = compareSeverity(severity, 'high')
      reasons.push(`Patch bump with unexpected breaking changes (v${fromVersion} → v${toVersion})`)
      reasons.push(...changelogAnalysis.breakingReasons)
    } else {
      severity = compareSeverity(severity, 'low')
    }
  }

  if (semverDiff.type === 'prerelease') {
    severity = compareSeverity(severity, 'low')
    reasons.push(semverDiff.description)
  }

  if (!reasons.length) {
    reasons.push('No significant changes detected')
  }

  const recommendation = buildRecommendation(severity, packageName, semverDiff, changelogAnalysis, options)

  return {
    packageName,
    fromVersion,
    toVersion,
    severity,
    semverDiff,
    changelogAnalysis,
    reasons,
    recommendation,
  }
}

function analyzeChangelogImpact(entry: ChangelogEntry) {
  return {
    hasBreakingChanges: entry.breakingChanges.length > 0,
    breakingReasons: entry.breakingChanges,
  }
}

const SEVERITY_RANK: Record<ChangeSeverity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  none: 1,
}

function compareSeverity(current: ChangeSeverity, candidate: ChangeSeverity): ChangeSeverity {
  return SEVERITY_RANK[candidate] > SEVERITY_RANK[current] ? candidate : current
}

function buildRecommendation(
  severity: ChangeSeverity,
  packageName: string,
  _semverDiff: SemverDiff,
  _changelogAnalysis?: { hasBreakingChanges: boolean; breakingReasons: string[] },
  _options?: ClassificationOptions,
): string {
  switch (severity) {
    case 'critical':
      return `Blocking: Manual review required before upgrading ${packageName}. Check API compatibility and run full test suite.`
    case 'high':
      return `Warning: Review ${packageName} changes carefully. Run integration tests after upgrade.`
    case 'medium':
      return `Caution: Review changelog for ${packageName} before upgrading in production.`
    case 'low':
      return `Safe: ${packageName} can be upgraded during normal maintenance.`
    case 'none':
      return `No action needed for ${packageName}.`
  }
}