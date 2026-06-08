import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';
import { DependencyInfo, analyzeVersionChange, pollNpmRegistry } from '../connectors/npm-registry';

export interface Dependency {
  id: string;
  name: string;
  currentVersion: string;
  specifiedRange: string;
  isDev: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DependencyUpdate {
  id: string;
  dependencyId: string;
  availableVersion: string;
  currentVersion: string;
  changeType: 'major' | 'minor' | 'patch' | 'unknown';
  isBreaking: boolean;
  changelogUrl: string | null;
  detectedAt: string;
}

export class DependencyModel {
  constructor(private db: Database) {}

  getAll(): Dependency[] {
    const result = this.db.exec(
      'SELECT id, name, current_version, specified_range, is_dev, created_at, updated_at FROM dependencies ORDER BY name'
    );
    if (result.length === 0 || result[0].values.length === 0) return [];
    return result[0].values.map((row: any) => ({
      id: row[0] as string,
      name: row[1] as string,
      currentVersion: row[2] as string,
      specifiedRange: row[3] as string,
      isDev: (row[4] as number) === 1,
      createdAt: row[5] as string,
      updatedAt: row[6] as string,
    }));
  }

  getByName(name: string): Dependency | null {
    const result = this.db.exec(
      'SELECT id, name, current_version, specified_range, is_dev, created_at, updated_at FROM dependencies WHERE name = ?',
      [name]
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    return {
      id: row[0] as string,
      name: row[1] as string,
      currentVersion: row[2] as string,
      specifiedRange: row[3] as string,
      isDev: (row[4] as number) === 1,
      createdAt: row[5] as string,
      updatedAt: row[6] as string,
    };
  }

  upsert(info: DependencyInfo): Dependency {
    const existing = this.getByName(info.name);
    if (existing) {
      this.db.run(
        'UPDATE dependencies SET current_version = ?, specified_range = ?, is_dev = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [info.currentVersion, info.specifiedRange, info.isDev ? 1 : 0, existing.id]
      );
      return { ...existing, currentVersion: info.currentVersion, specifiedRange: info.specifiedRange, isDev: info.isDev, updatedAt: new Date().toISOString() };
    }

    const id = uuidv4();
    this.db.run(
      'INSERT INTO dependencies (id, name, current_version, specified_range, is_dev) VALUES (?, ?, ?, ?, ?)',
      [id, info.name, info.currentVersion, info.specifiedRange, info.isDev ? 1 : 0]
    );
    return { id, name: info.name, currentVersion: info.currentVersion, specifiedRange: info.specifiedRange, isDev: info.isDev, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }

  async checkForUpdates(dependency: Dependency): Promise<DependencyUpdate | null> {
    const pkgInfo = await pollNpmRegistry(dependency.name);
    if (!pkgInfo || pkgInfo.latestVersion === 'unknown') return null;

    if (pkgInfo.latestVersion === dependency.currentVersion) return null;

    const analysis = analyzeVersionChange(dependency.currentVersion, pkgInfo.latestVersion);

    const id = uuidv4();
    this.db.run(
      'INSERT INTO dependency_updates (id, dependency_id, available_version, current_version, change_type, is_breaking, changelog_url) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, dependency.id, pkgInfo.latestVersion, dependency.currentVersion, analysis.changeType, analysis.isBreaking ? 1 : 0, pkgInfo.repository || null]
    );

    return {
      id,
      dependencyId: dependency.id,
      availableVersion: pkgInfo.latestVersion,
      currentVersion: dependency.currentVersion,
      changeType: analysis.changeType,
      isBreaking: analysis.isBreaking,
      changelogUrl: pkgInfo.repository || null,
      detectedAt: new Date().toISOString(),
    };
  }

  getUpdates(limit: number = 50, offset: number = 0, breakingOnly: boolean = false): { updates: DependencyUpdate[]; count: number } {
    let sql = 'SELECT du.id, du.dependency_id, du.available_version, du.current_version, du.change_type, du.is_breaking, du.changelog_url, du.detected_at FROM dependency_updates du';
    let countSql = 'SELECT COUNT(*) FROM dependency_updates';
    const params: any[] = [];

    if (breakingOnly) {
      sql += ' WHERE du.is_breaking = 1';
      countSql += ' WHERE is_breaking = 1';
    }

    sql += ' ORDER BY du.detected_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const countResult = this.db.exec(countSql);
    const totalCount = countResult.length > 0 && countResult[0].values.length > 0
      ? (countResult[0].values[0][0] as number) : 0;

    const result = this.db.exec(sql, params);
    const updates = result.length > 0 ? result[0].values.map((row: any) => ({
      id: row[0] as string,
      dependencyId: row[1] as string,
      availableVersion: row[2] as string,
      currentVersion: row[3] as string,
      changeType: row[4] as 'major' | 'minor' | 'patch' | 'unknown',
      isBreaking: (row[5] as number) === 1,
      changelogUrl: row[6] as string | null,
      detectedAt: row[7] as string,
    })) : [];

    return { updates, count: totalCount };
  }
}

export async function runDependencyCheck(
  db: Database,
  packageJsonContent: string,
): Promise<{ dependenciesChecked: number; updatesFound: number; breakingChanges: number }> {
  const model = new DependencyModel(db);
  const { parsePackageJson } = require('../connectors/npm-registry');
  const deps = parsePackageJson(packageJsonContent);
  let updatesFound = 0;
  let breakingChanges = 0;

  for (const dep of deps) {
    const dependency = model.upsert(dep);
    const update = await model.checkForUpdates(dependency);
    if (update) {
      updatesFound++;
      if (update.isBreaking) breakingChanges++;
    }
  }

  return { dependenciesChecked: deps.length, updatesFound, breakingChanges };
}