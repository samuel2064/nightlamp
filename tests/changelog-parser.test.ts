import { describe, it, expect } from 'vitest'
import { parseConventionalCommit, parseChangelog, classifyBreakingReason, extractBreakingChangesFromCommits } from '../src/analyzers/changelog-parser.js'

describe('parseConventionalCommit', () => {
  it('parses a simple feat commit', () => {
    const result = parseConventionalCommit('feat: add new endpoint')
    expect(result).toEqual({
      type: 'feat',
      scope: undefined,
      description: 'add new endpoint',
      breaking: false,
    })
  })

  it('parses a commit with scope', () => {
    const result = parseConventionalCommit('fix(api): handle null response')
    expect(result).toEqual({
      type: 'fix',
      scope: 'api',
      description: 'handle null response',
      breaking: false,
    })
  })

  it('detects breaking change indicator', () => {
    const result = parseConventionalCommit('feat!: drop support for v1 API')
    expect(result).toEqual({
      type: 'feat',
      scope: undefined,
      description: 'drop support for v1 API',
      breaking: true,
    })
  })

  it('detects breaking change with scope', () => {
    const result = parseConventionalCommit('feat(auth)!: require OAuth2 tokens')
    expect(result).toEqual({
      type: 'feat',
      scope: 'auth',
      description: 'require OAuth2 tokens',
      breaking: true,
    })
  })

  it('returns null for non-conventional commit', () => {
    expect(parseConventionalCommit('fixed a bug')).toBeNull()
  })

  it('parses chore commit', () => {
    const result = parseConventionalCommit('chore(deps): bump lodash from 4.17.20 to 4.17.21')
    expect(result?.type).toBe('chore')
    expect(result?.scope).toBe('deps')
  })

  it('handles uppercase type', () => {
    const result = parseConventionalCommit('FIX: hotfix for crash')
    expect(result?.type).toBe('fix')
  })
})

describe('parseChangelog', () => {
  it('parses a simple keep-a-changelog format', () => {
    const changelog = `# Changelog

## [1.2.0] - 2024-03-15

### Added
- New feature A
- New feature B

### Fixed
- Bug fix for crash

## [1.1.0] - 2024-02-01

### Added
- Initial features`

    const entries = parseChangelog(changelog)
    expect(entries).toHaveLength(2)
    expect(entries[0].version).toBe('1.2.0')
    expect(entries[0].date).toBe('2024-03-15')
    expect(entries[0].sections.added).toEqual(['New feature A', 'New feature B'])
    expect(entries[0].sections.fixed).toEqual(['Bug fix for crash'])
    expect(entries[1].version).toBe('1.1.0')
  })

  it('detects breaking changes in changelog', () => {
    const changelog = `## [2.0.0] - 2024-06-01

### Breaking Changes
- Removed deprecated v1 API
- Changed authentication flow

### Added
- New v2 API endpoints`

    const entries = parseChangelog(changelog)
    expect(entries).toHaveLength(1)
    expect(entries[0].breakingChanges).toHaveLength(2)
    expect(entries[0].breakingChanges[0]).toContain('Removed deprecated')
    expect(entries[0].breakingChanges[1]).toContain('Changed authentication')
  })

  it('detects breaking keyword in items', () => {
    const changelog = `## [1.5.0] - 2024-04-01

### Changed
- This is a breaking change to the config format`

    const entries = parseChangelog(changelog)
    expect(entries[0].breakingChanges).toHaveLength(1)
  })

  it('handles version without date', () => {
    const changelog = '## [1.0.0]\n\n### Added\n- Initial release'
    const entries = parseChangelog(changelog)
    expect(entries[0].date).toBeUndefined()
  })

  it('handles prerelease versions', () => {
    const changelog = '## [2.0.0-beta.1] - 2024-05-01\n\n### Added\n- Beta features'
    const entries = parseChangelog(changelog)
    expect(entries[0].version).toBe('2.0.0-beta.1')
  })

  it('handles empty changelog', () => {
    const entries = parseChangelog('')
    expect(entries).toHaveLength(0)
  })

  it('handles markdown h3 headers', () => {
    const changelog = `### [0.1.0] - 2024-01-01

### Added
- Initial`

    const entries = parseChangelog(changelog)
    expect(entries).toHaveLength(1)
    expect(entries[0].version).toBe('0.1.0')
  })
})

describe('classifyBreakingReason', () => {
  it('returns high severity for multiple breaking changes', () => {
    const entry = {
      version: '2.0.0',
      date: '2024-06-01',
      sections: { breaking_changes: ['Removed v1 API', 'Changed auth', 'New config format'] },
      breakingChanges: ['Removed v1 API', 'Changed auth', 'New config format'],
    }
    const result = classifyBreakingReason(entry)
    expect(result.isBreaking).toBe(true)
    expect(result.severity).toBe('high')
    expect(result.reasons).toHaveLength(3)
  })

  it('returns low severity for no breaking changes', () => {
    const entry = {
      version: '1.1.0',
      date: '2024-03-01',
      sections: { added: ['New feature'] },
      breakingChanges: [],
    }
    const result = classifyBreakingReason(entry)
    expect(result.isBreaking).toBe(false)
    expect(result.severity).toBe('low')
  })

  it('extracts migration notes', () => {
    const entry = {
      version: '3.0.0',
      date: undefined,
      sections: { migration_guide: ['Update config key from old_key to new_key'] },
      breakingChanges: [],
    }
    const result = classifyBreakingReason(entry)
    expect(result.isBreaking).toBe(true)
    expect(result.reasons[0]).toContain('Update config key')
  })
})

describe('extractBreakingChangesFromCommits', () => {
  it('filters commits with breaking ! marker', () => {
    const commits = [
      { type: 'feat', description: 'add feature', breaking: false },
      { type: 'feat', description: 'breaking change to API', breaking: true },
      { type: 'fix', description: 'fix bug', breaking: false },
    ]
    const breaking = extractBreakingChangesFromCommits(commits)
    expect(breaking).toHaveLength(1)
    expect(breaking[0].description).toBe('breaking change to API')
  })
})