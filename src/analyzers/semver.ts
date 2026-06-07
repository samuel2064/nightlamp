export interface SemverVersion {
  major: number
  minor: number
  patch: number
  prerelease?: string
  build?: string
}

export interface SemverDiff {
  from: SemverVersion
  to: SemverVersion
  type: 'major' | 'minor' | 'patch' | 'prerelease' | 'no_change' | 'downgrade'
  description: string
}

const SEMVER_RE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[a-zA-Z0-9.]+))?(?:\+(?<build>[a-zA-Z0-9.]+))?$/

export function parseSemver(version: string): SemverVersion | null {
  const match = version.trim().match(SEMVER_RE)
  if (!match) return null

  const g = match.groups!
  return {
    major: parseInt(g.major, 10),
    minor: parseInt(g.minor, 10),
    patch: parseInt(g.patch, 10),
    prerelease: g.prerelease || undefined,
    build: g.build || undefined,
  }
}

export function compareSemver(a: string | SemverVersion, b: string | SemverVersion): SemverDiff {
  const vA = typeof a === 'string' ? parseSemver(a) : a
  const vB = typeof b === 'string' ? parseSemver(b) : b

  if (!vA || !vB) {
    return {
      from: vA || parseSemver('0.0.0')!,
      to: vB || parseSemver('0.0.0')!,
      type: 'no_change',
      description: 'Invalid version string provided',
    }
  }

  if (vB.major < vA.major) {
    return { from: vA, to: vB, type: 'downgrade', description: `Downgrade from ${fmt(vA)} to ${fmt(vB)}` }
  }

  if (vB.major > vA.major) {
    return { from: vA, to: vB, type: 'major', description: `Major bump: ${fmt(vA)} → ${fmt(vB)}` }
  }

  if (vB.minor < vA.minor) {
    return { from: vA, to: vB, type: 'downgrade', description: `Downgrade from ${fmt(vA)} to ${fmt(vB)}` }
  }

  if (vB.minor > vA.minor) {
    return { from: vA, to: vB, type: 'minor', description: `Minor bump: ${fmt(vA)} → ${fmt(vB)}` }
  }

  if (vB.patch < vA.patch) {
    return { from: vA, to: vB, type: 'downgrade', description: `Downgrade from ${fmt(vA)} to ${fmt(vB)}` }
  }

  if (vB.patch > vA.patch) {
    return { from: vA, to: vB, type: 'patch', description: `Patch bump: ${fmt(vA)} → ${fmt(vB)}` }
  }

  if (vA.prerelease && !vB.prerelease) {
    return { from: vA, to: vB, type: 'minor', description: `Prerelease → release: ${fmt(vA)} → ${fmt(vB)}` }
  }

  if (!vA.prerelease && vB.prerelease) {
    return { from: vA, to: vB, type: 'prerelease', description: `New prerelease: ${fmt(vA)} → ${fmt(vB)}` }
  }

  if (vA.prerelease !== vB.prerelease) {
    return { from: vA, to: vB, type: 'prerelease', description: `Prerelease changed: ${fmt(vA)} → ${fmt(vB)}` }
  }

  return { from: vA, to: vB, type: 'no_change', description: 'No version change' }
}

function fmt(v: SemverVersion): string {
  let s = `${v.major}.${v.minor}.${v.patch}`
  if (v.prerelease) s += `-${v.prerelease}`
  if (v.build) s += `+${v.build}`
  return s
}

export function isBreakingChange(diff: SemverDiff): boolean {
  return diff.type === 'major' || (diff.type === 'minor' && diff.to.major === 0 && diff.to.minor > diff.from.minor)
}

export function versionToString(v: SemverVersion): string {
  return fmt(v)
}