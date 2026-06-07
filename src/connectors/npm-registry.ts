export interface NpmPackageInfo {
  name: string
  latestVersion: string
  description?: string
  repository?: string
  homepage?: string
  allVersions: string[]
}

export interface PackageJson {
  name?: string
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

const NPM_REGISTRY_BASE = 'https://registry.npmjs.org'

export async function pollNpmRegistry(packageName: string): Promise<NpmPackageInfo> {
  const encoded = encodeURIComponent(packageName).replace(/^%40/, '@')
  const url = `${NPM_REGISTRY_BASE}/${encoded}`
  const res = await fetch(url)

  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${packageName}`)
  }

  const data = await res.json() as {
    name: string
    description?: string
    homepage?: string
    repository?: { url?: string }
    'dist-tags'?: Record<string, string>
    versions?: Record<string, unknown>
  }

  return {
    name: data.name,
    latestVersion: data['dist-tags']?.latest || '0.0.0',
    description: data.description,
    repository: data.repository?.url,
    homepage: data.homepage,
    allVersions: data.versions ? Object.keys(data.versions) : [],
  }
}

export function parsePackageJson(content: string): PackageJson {
  try {
    const parsed = JSON.parse(content) as PackageJson
    return parsed
  } catch {
    throw new Error('Invalid package.json: unable to parse JSON')
  }
}

export function extractDependencies(pkg: PackageJson): Array<{ name: string; version: string; type: 'dependencies' | 'devDependencies' | 'peerDependencies' }> {
  const result: Array<{ name: string; version: string; type: 'dependencies' | 'devDependencies' | 'peerDependencies' }> = []

  if (pkg.dependencies) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      result.push({ name, version, type: 'dependencies' })
    }
  }
  if (pkg.devDependencies) {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      result.push({ name, version, type: 'devDependencies' })
    }
  }
  if (pkg.peerDependencies) {
    for (const [name, version] of Object.entries(pkg.peerDependencies)) {
      result.push({ name, version, type: 'peerDependencies' })
    }
  }

  return result
}

const VERSION_RANGE_RE = /^[\^~]?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/

export function resolveRangeToVersion(range: string): string | null {
  const match = range.trim().match(VERSION_RANGE_RE)
  return match ? `${match.groups!.major}.${match.groups!.minor}.${match.groups!.patch}` : null
}