export interface ChangelogEntry {
  version: string
  date?: string
  sections: Record<string, string[]>
  breakingChanges: string[]
}

export interface ParsedCommit {
  type: string
  scope?: string
  description: string
  breaking: boolean
  body?: string
  footer?: string
}

const COMMIT_PATTERN = /^(?<type>\w+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?:\s*(?<description>.+)$/

const KNOWN_TYPES = new Set([
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert',
])

export function parseConventionalCommit(line: string): ParsedCommit | null {
  const match = line.trim().match(COMMIT_PATTERN)
  if (!match) return null

  const groups = match.groups!
  const type = groups.type.toLowerCase()
  const scope = groups.scope || undefined
  const description = groups.description
  const breaking = groups.breaking === '!' || false

  return { type, scope, description, breaking }
}

export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  const lines = text.split('\n')

  let currentEntry: ChangelogEntry | null = null
  let currentSection: string | null = null

  const versionHeaderRe = /^#{2,3}\s+\[?(?<version>\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)\]?\s*(?:-|\()?\s*(?<date>\d{4}-\d{2}-\d{2})?/

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue

    const versionMatch = line.match(versionHeaderRe)
    if (versionMatch) {
      if (currentEntry) entries.push(currentEntry)
      currentEntry = {
        version: versionMatch.groups!.version,
        date: versionMatch.groups!.date || undefined,
        sections: {},
        breakingChanges: [],
      }
      currentSection = null
      continue
    }

    const sectionHeaderRe = /^#{3,4}\s+(?<name>.+)$/
    const sectionMatch = line.match(sectionHeaderRe)
    if (sectionMatch && currentEntry) {
      currentSection = sectionMatch.groups!.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '')
      continue
    }

    if (currentEntry && currentSection && line.startsWith('-')) {
      const item = line.replace(/^-\s*/, '')
      if (!currentEntry.sections[currentSection]) {
        currentEntry.sections[currentSection] = []
      }
      currentEntry.sections[currentSection].push(item)

      const isBreakingSection = /breaking|migration|deprecat/i.test(currentSection)
      if (isBreakingSection || /breaking/i.test(item) || line.toLowerCase().includes('breaking change')) {
        currentEntry.breakingChanges.push(item)
      }
    }
  }

  if (currentEntry) entries.push(currentEntry)
  return entries
}

export function classifyBreakingReason(entry: ChangelogEntry): {
  isBreaking: boolean
  reasons: string[]
  severity: 'high' | 'medium' | 'low'
} {
  const reasons: string[] = []

  if (entry.breakingChanges.length > 0) {
    reasons.push(...entry.breakingChanges.map(r => `Breaking change: ${r}`))
  }

  const breakingSections = ['breaking_changes', 'breaking changes', 'breaks', 'migration_guide', 'migration notes']
  for (const key of Object.keys(entry.sections)) {
    if (breakingSections.some(bs => key.includes(bs.replace(/\s+/g, '_')))) {
      for (const item of entry.sections[key]) {
        if (!reasons.some(r => r.includes(item))) {
          reasons.push(`Migration required: ${item}`)
        }
      }
    }
  }

  const isBreaking = reasons.length > 0
  const severity: 'high' | 'medium' | 'low' = isBreaking
    ? (reasons.length > 2 ? 'high' : 'medium')
    : 'low'

  return { isBreaking, reasons, severity }
}

export function extractBreakingChangesFromCommits(commits: ParsedCommit[]): ParsedCommit[] {
  return commits.filter(c => c.breaking || /^BREAKING\s*CHANGE/i.test(c.description))
}