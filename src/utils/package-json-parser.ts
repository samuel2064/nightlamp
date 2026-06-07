export interface PackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface ExtractedDependency {
  name: string
  version: string
  type: 'dependencies' | 'devDependencies' | 'peerDependencies'
}

const VERSION_RANGE_RE = /^[\^~]?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/

export function parsePackageJson(content: string): PackageJson {
  try {
    return JSON.parse(content) as PackageJson
  } catch {
    throw new Error('Invalid package.json: unable to parse JSON')
  }
}

export function extractDependencies(pkg: PackageJson): ExtractedDependency[] {
  const result: ExtractedDependency[] = []

  for (const type of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const deps = pkg[type]
    if (deps) {
      for (const [name, version] of Object.entries(deps)) {
        result.push({ name, version, type })
      }
    }
  }

  return result
}

export function resolveRangeToVersion(range: string): string | null {
  const match = range.trim().match(VERSION_RANGE_RE)
  return match ? `${match.groups!.major}.${match.groups!.minor}.${match.groups!.patch}` : null
}

export function normalizePackageJsonPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.endsWith('package.json') ? normalized : `${normalized}/package.json`
}
