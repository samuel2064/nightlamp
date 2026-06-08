export interface ChangelogEntry {
  version: string;
  title: string;
  body: string;
  isBreaking: boolean;
  date: string | null;
}

export interface ChangelogResult {
  entries: ChangelogEntry[];
  latestBreakingVersion: string | null;
  breakingCount: number;
}

function parseConventionalCommitLine(line: string): { isBreaking: boolean; type: string; description: string } | null {
  const trimmed = line.replace(/^[-*\s]+/, '').trim();
  if (!trimmed) return null;

  const isBreaking = trimmed.includes('BREAKING CHANGE') || trimmed.includes('!(') || trimmed.includes('!:');

  const match = trimmed.match(/^(\w+)(\([^)]+\))?!?\s*:\s*(.+)/i);
  if (match) {
    return { isBreaking: isBreaking || !!match[2]?.includes('!'), type: match[1].toLowerCase(), description: match[3] };
  }

  const bangMatch = trimmed.match(/^(\w+)!\s*:\s*(.+)/i);
  if (bangMatch) {
    return { isBreaking: true, type: bangMatch[1].toLowerCase(), description: bangMatch[2] };
  }

  return { isBreaking, type: 'other', description: trimmed };
}

export function parseChangelogMarkdown(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = markdown.split('\n');

  let currentVersion: string | null = null;
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  let currentDate: string | null = null;
  let inEntry = false;

  const versionHeaderRegex = /^#{2,3}\s+\[?(\d+\.\d+\.\d[^\]\s]*)\]?\s*[-–—]\s*(.*)/;
  const versionHeaderAlt = /^#{2,3}\s+\[?(\d+\.\d+\.\d[^\]\s]*)\]?\s*(.*)/;
  const dateRegex = /(\d{4}-\d{2}-\d{2})/;

  for (const line of lines) {
    let match = line.match(versionHeaderRegex);
    if (!match) match = line.match(versionHeaderAlt);

    if (match) {
      if (inEntry && currentVersion) {
        entries.push({
          version: currentVersion,
          title: currentTitle || currentVersion,
          body: currentBody.join('\n').trim(),
          isBreaking: currentBody.some(l => l.includes('BREAKING CHANGE') || l.includes('!(') || l.includes('!:')),
          date: currentDate,
        });
      }

      currentVersion = match[1].replace(/[\[\]]/g, '').trim();
      currentTitle = match[0].trim();
      currentBody = [];
      inEntry = true;

      const dateMatch = line.match(dateRegex);
      currentDate = dateMatch ? dateMatch[1] : null;
    } else if (inEntry) {
      currentBody.push(line);
    }
  }

  if (inEntry && currentVersion) {
    entries.push({
      version: currentVersion,
      title: currentTitle || currentVersion,
      body: currentBody.join('\n').trim(),
      isBreaking: currentBody.some(l => l.includes('BREAKING CHANGE') || l.includes('!(') || l.includes('!:')),
      date: currentDate,
    });
  }

  return entries;
}

export function analyzeChangelogForBreaking(
  currentVersion: string,
  targetVersion: string,
  entries: ChangelogEntry[]
): ChangelogResult {
  let latestBreakingVersion: string | null = null;
  let breakingCount = 0;

  const targetIndex = entries.findIndex(e => e.version === targetVersion);
  const currentIndex = entries.findIndex(e => e.version === currentVersion);

  if (targetIndex === -1 || currentIndex === -1) {
    return { entries, latestBreakingVersion: null, breakingCount: 0 };
  }

  const start = Math.min(targetIndex, currentIndex);
  const end = Math.max(targetIndex, currentIndex);

  for (let i = start; i <= end; i++) {
    if (entries[i].isBreaking) {
      breakingCount++;
      if (!latestBreakingVersion) latestBreakingVersion = entries[i].version;
    }
  }

  return { entries, latestBreakingVersion, breakingCount };
}

export function classifyChangeSeverity(
  currentVersion: string,
  targetVersion: string,
  changelogResult: ChangelogResult
): { severity: 'critical' | 'high' | 'medium' | 'low' | 'none'; reasons: string[] } {
  const reasons: string[] = [];

  const parseVer = (v: string): number[] => {
    const cleaned = v.replace(/^[vV]/, '').split('.');
    return cleaned.map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  };

  const current = parseVer(currentVersion);
  const target = parseVer(targetVersion);

  if (current.length < 1 || target.length < 1) {
    return { severity: 'none', reasons: ['Unable to parse version numbers'] };
  }

  const majorDiff = target[0] !== current[0];
  const breakingInChangelog = changelogResult.breakingCount > 0;
  const latestBreaking = changelogResult.latestBreakingVersion;

  if (breakingInChangelog) {
    reasons.push(`${changelogResult.breakingCount} breaking change(s) found in changelog`);
    if (latestBreaking) reasons.push(`Latest breaking version: ${latestBreaking}`);
  }

  if (majorDiff) {
    reasons.push(`Major version bump: ${currentVersion} -> ${targetVersion}`);
    if (breakingInChangelog) {
      return { severity: 'critical', reasons };
    }
    return { severity: 'high', reasons };
  }

  if (breakingInChangelog) {
    return { severity: 'high', reasons };
  }

  if (target.length > 1 && current.length > 1 && target[1] !== current[1]) {
    reasons.push(`Minor version bump: ${currentVersion} -> ${targetVersion}`);
    return { severity: 'medium', reasons };
  }

  if (target.length > 2 && current.length > 2 && target[2] !== current[2]) {
    reasons.push(`Patch version bump: ${currentVersion} -> ${targetVersion}`);
    return { severity: 'low', reasons };
  }

  if (currentVersion !== targetVersion) {
    reasons.push(`Version changed: ${currentVersion} -> ${targetVersion}`);
    return { severity: 'low', reasons };
  }

  return { severity: 'none', reasons: ['No change detected'] };
}

export function extractGithubRepoFromNpmInfo(npmPackageInfo: any): string | null {
  if (npmPackageInfo.repository?.url) {
    const url = npmPackageInfo.repository.url;
    const match = url.match(/github\.com[:\/]([^/]+)\/([^/.]+)/);
    if (match) return `${match[1]}/${match[2]}`;
  }
  return null;
}

export async function fetchChangelogFromGithub(repo: string, version?: string): Promise<string | null> {
  try {
    const urls = [
      `https://raw.githubusercontent.com/${repo}/main/CHANGELOG.md`,
      `https://raw.githubusercontent.com/${repo}/master/CHANGELOG.md`,
    ];

    if (version) {
      urls.unshift(`https://raw.githubusercontent.com/${repo}/v${version}/CHANGELOG.md`);
    }

    for (const url of urls) {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
    }

    return null;
  } catch {
    return null;
  }
}