export interface DependencyInfo {
  name: string;
  currentVersion: string;
  specifiedRange: string;
  isDev: boolean;
}

export interface NpmPackageInfo {
  name: string;
  latestVersion: string;
  versions: string[];
  description: string;
  repository?: string;
  homepage?: string;
}

export function parsePackageJson(content: string): DependencyInfo[] {
  const pkg = JSON.parse(content);
  const deps: DependencyInfo[] = [];

  const addDeps = (obj: Record<string, string> | undefined, isDev: boolean) => {
    if (!obj) return;
    for (const [name, range] of Object.entries(obj)) {
      deps.push({
        name,
        currentVersion: resolveCurrentVersion(range),
        specifiedRange: range,
        isDev,
      });
    }
  };

  addDeps(pkg.dependencies, false);
  addDeps(pkg.devDependencies, true);

  return deps;
}

function resolveCurrentVersion(range: string): string {
  const cleaned = range.replace(/^[\^~>=<]+\s*/, '');
  return cleaned.split(' ')[0].split('||')[0].split('|')[0].trim();
}

export async function pollNpmRegistry(packageName: string): Promise<NpmPackageInfo | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
      headers: { 'Accept': 'application/vnd.npm.install-v1+json' },
    });
    if (!response.ok) return null;

    const data: any = await response.json();
    const versions = data.versions ? Object.keys(data.versions) : [];

    return {
      name: data.name || packageName,
      latestVersion: data['dist-tags']?.latest || versions[versions.length - 1] || 'unknown',
      versions,
      description: data.description || '',
      repository: data.repository?.url,
      homepage: data.homepage,
    };
  } catch {
    return null;
  }
}

export function analyzeVersionChange(
  currentVersion: string,
  availableVersion: string,
): { changeType: 'major' | 'minor' | 'patch' | 'unknown'; isBreaking: boolean } {
  const parseVer = (v: string): number[] => {
    const cleaned = v.replace(/^[vV]/, '').split('.');
    return cleaned.map(s => parseInt(s, 10)).filter(n => !isNaN(n));
  };

  const current = parseVer(currentVersion);
  const available = parseVer(availableVersion);

  if (current.length < 1 || available.length < 1) {
    return { changeType: 'unknown', isBreaking: false };
  }

  if (current[0] !== available[0]) {
    return { changeType: 'major', isBreaking: true };
  }

  if (current.length > 1 && available.length > 1 && current[1] !== available[1]) {
    return { changeType: 'minor', isBreaking: false };
  }

  if (current.length > 2 && available.length > 2 && current[2] !== available[2]) {
    return { changeType: 'patch', isBreaking: false };
  }

  if (currentVersion !== availableVersion) {
    return { changeType: 'patch', isBreaking: false };
  }

  return { changeType: 'unknown', isBreaking: false };
}