import { getDb } from '../db.js'
import { pollNpmRegistry } from '../connectors/npm-registry.js'
import { extractDependencies, parsePackageJson, resolveRangeToVersion } from '../utils/package-json-parser.js'
import { compareSemver, isBreakingChange } from '../analyzers/semver.js'
import { classifyChange } from '../analyzers/severity-classifier.js'
import type { ClassifiedChange } from '../analyzers/severity-classifier.js'

export interface DependencyRecord {
  id?: number
  name: string
  currentVersion: string
  latestVersion: string
  type: 'dependencies' | 'devDependencies' | 'peerDependencies'
  updatedAt?: string
}

export interface DependencyUpdate {
  id?: number
  dependencyId: number
  fromVersion: string
  toVersion: string
  changeType: string
  severity: string
  detectedAt: string
  breaking: boolean
  summary: string
}

function rowToDependencyRecord(row: Record<string, unknown>): DependencyRecord {
  return {
    id: row.id as number,
    name: row.name as string,
    currentVersion: row.current_version as string,
    latestVersion: row.latest_version as string,
    type: row.type as DependencyRecord['type'],
    updatedAt: row.updated_at as string,
  }
}

function rowToDependencyUpdate(row: Record<string, unknown>): DependencyUpdate {
  return {
    id: row.id as number,
    dependencyId: row.dependency_id as number,
    fromVersion: row.from_version as string,
    toVersion: row.to_version as string,
    changeType: row.change_type as string,
    severity: row.severity as string,
    detectedAt: row.detected_at as string,
    breaking: (row.breaking as number) === 1,
    summary: row.summary as string,
  }
}

export function resetStore(): void {
  const db = getDb()
  db.run('DELETE FROM dependency_updates')
  db.run('DELETE FROM dependencies')
}

export function resetHealthSnapshots(): void {
  getDb().run('DELETE FROM dependency_health_snapshots')
}

export function resetAlertRules(): void {
  getDb().run('DELETE FROM dependency_alert_rules')
}

export async function upsertDependency(record: Omit<DependencyRecord, 'id' | 'updatedAt'>): Promise<DependencyRecord> {
  const db = getDb()
  const now = new Date().toISOString()

  const existing = db.exec(
    'SELECT * FROM dependencies WHERE name = ?',
    [record.name],
  )

  if (existing.length > 0 && existing[0].values.length > 0) {
    const cols = existing[0].columns
    const vals = existing[0].values[0]
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })

    db.run(
      'UPDATE dependencies SET current_version = ?, latest_version = ?, type = ?, updated_at = ? WHERE name = ?',
      [record.currentVersion, record.latestVersion, record.type, now, record.name],
    )

    return { ...rowToDependencyRecord(row), currentVersion: record.currentVersion, latestVersion: record.latestVersion, updatedAt: now }
  }

  db.run(
    'INSERT INTO dependencies (name, current_version, latest_version, type, updated_at) VALUES (?, ?, ?, ?, ?)',
    [record.name, record.currentVersion, record.latestVersion, record.type, now],
  )

  const result = db.exec('SELECT * FROM dependencies WHERE name = ?', [record.name])
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToDependencyRecord(row)
}

export function getAllDependencies(): DependencyRecord[] {
  const db = getDb()
  const result = db.exec('SELECT * FROM dependencies ORDER BY name')
  if (result.length === 0) return []
  const cols = result[0].columns
  return result[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    return rowToDependencyRecord(row)
  })
}

export function getDependencyByName(name: string): DependencyRecord | undefined {
  const db = getDb()
  const result = db.exec('SELECT * FROM dependencies WHERE name = ?', [name])
  if (result.length === 0 || result[0].values.length === 0) return undefined
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToDependencyRecord(row)
}

export async function checkForUpdates(name: string): Promise<DependencyUpdate | null> {
  const dep = getDependencyByName(name)
  if (!dep) throw new Error(`Dependency ${name} not found`)

  const info = await pollNpmRegistry(name)
  if (info.latestVersion === dep.latestVersion) return null

  const semverDiff = compareSemver(dep.currentVersion, info.latestVersion)
  const breaking = isBreakingChange(semverDiff)

  const db = getDb()
  db.run(
    'UPDATE dependencies SET latest_version = ?, updated_at = datetime(\'now\') WHERE name = ?',
    [info.latestVersion, name],
  )

  db.run(
    'INSERT INTO dependency_updates (dependency_id, from_version, to_version, change_type, severity, breaking, summary) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [dep.id!, dep.currentVersion, info.latestVersion, semverDiff.type, breaking ? 'high' : 'low', breaking ? 1 : 0, semverDiff.description],
  )

  const result = db.exec(
    'SELECT * FROM dependency_updates WHERE id = last_insert_rowid()',
  )
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToDependencyUpdate(row)
}

export function getUpdates(options?: { breakingOnly?: boolean; limit?: number; offset?: number }): DependencyUpdate[] {
  const db = getDb()
  let sql = 'SELECT * FROM dependency_updates'
  const params: (number | string)[] = []

  if (options?.breakingOnly) {
    sql += ' WHERE breaking = 1'
  }

  sql += ' ORDER BY detected_at DESC'

  if (options?.limit) {
    const off = options.offset || 0
    sql += ' LIMIT ? OFFSET ?'
    params.push(options.limit, off)
  }

  const result = db.exec(sql, params)
  if (result.length === 0) return []
  const cols = result[0].columns
  return result[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    return rowToDependencyUpdate(row)
  })
}

export function getUpdatesByDependencyId(dependencyId: number): DependencyUpdate[] {
  const db = getDb()
  const result = db.exec(
    'SELECT * FROM dependency_updates WHERE dependency_id = ? ORDER BY detected_at DESC',
    [dependencyId],
  )
  if (result.length === 0) return []
  const cols = result[0].columns
  return result[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    return rowToDependencyUpdate(row)
  })
}

export function getUpdatesBySeverity(severity: string, options?: { limit?: number; offset?: number }): DependencyUpdate[] {
  const db = getDb()
  let sql = 'SELECT * FROM dependency_updates WHERE severity = ? ORDER BY detected_at DESC'
  const params: (string | number)[] = [severity]

  if (options?.limit) {
    const off = options.offset || 0
    sql += ' LIMIT ? OFFSET ?'
    params.push(options.limit, off)
  }

  const result = db.exec(sql, params)
  if (result.length === 0) return []
  const cols = result[0].columns
  return result[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    return rowToDependencyUpdate(row)
  })
}

export function deleteOldUpdates(beforeDate: string): number {
  const db = getDb()
  db.run('DELETE FROM dependency_updates WHERE detected_at < ?', [beforeDate])
  return db.getRowsModified()
}

export interface HealthSnapshot {
  id?: number
  totalDependencies: number
  upToDate: number
  outdated: number
  criticalCount: number
  highCount: number
  mediumCount: number
  lowCount: number
  breakingCount: number
  snapshotAt?: string
}

function rowToHealthSnapshot(row: Record<string, unknown>): HealthSnapshot {
  return {
    id: row.id as number,
    totalDependencies: row.total_dependencies as number,
    upToDate: row.up_to_date as number,
    outdated: row.outdated as number,
    criticalCount: row.critical_count as number,
    highCount: row.high_count as number,
    mediumCount: row.medium_count as number,
    lowCount: row.low_count as number,
    breakingCount: row.breaking_count as number,
    snapshotAt: row.snapshot_at as string,
  }
}

export function recordHealthSnapshot(): HealthSnapshot {
  const db = getDb()
  const deps = getAllDependencies()
  const updates = getUpdates()

  let upToDate = 0
  let outdated = 0

  for (const dep of deps) {
    if (dep.currentVersion === dep.latestVersion) {
      upToDate++
    } else {
      outdated++
    }
  }

  const criticalCount = updates.filter(u => u.severity === 'critical').length
  const highCount = updates.filter(u => u.severity === 'high').length
  const mediumCount = updates.filter(u => u.severity === 'medium').length
  const lowCount = updates.filter(u => u.severity === 'low').length
  const breakingCount = updates.filter(u => u.breaking).length

  db.run(
    `INSERT INTO dependency_health_snapshots
     (total_dependencies, up_to_date, outdated, critical_count, high_count, medium_count, low_count, breaking_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [deps.length, upToDate, outdated, criticalCount, highCount, mediumCount, lowCount, breakingCount],
  )

  const result = db.exec('SELECT * FROM dependency_health_snapshots WHERE id = last_insert_rowid()')
  if (result.length === 0) throw new Error('Failed to record health snapshot')
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToHealthSnapshot(row)
}

export function getHealthHistory(options?: { limit?: number; offset?: number }): HealthSnapshot[] {
  const db = getDb()
  let sql = 'SELECT * FROM dependency_health_snapshots ORDER BY snapshot_at DESC'
  const params: number[] = []

  if (options?.limit) {
    const off = options.offset || 0
    sql += ' LIMIT ? OFFSET ?'
    params.push(options.limit, off)
  }

  const result = db.exec(sql, params)
  if (result.length === 0) return []
  const cols = result[0].columns
  return result[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    return rowToHealthSnapshot(row)
  })
}

export interface AlertRule {
  id?: number
  packageName: string
  ruleType: 'breaking' | 'outdated' | 'security' | 'all'
  minSeverity: 'critical' | 'high' | 'medium' | 'low'
  channel: 'slack' | 'webhook' | 'email' | 'all'
  enabled: boolean
  createdAt?: string
  updatedAt?: string
}

function rowToAlertRule(row: Record<string, unknown>): AlertRule {
  return {
    id: row.id as number,
    packageName: row.package_name as string,
    ruleType: row.rule_type as AlertRule['ruleType'],
    minSeverity: row.min_severity as AlertRule['minSeverity'],
    channel: row.channel as AlertRule['channel'],
    enabled: (row.enabled as number) === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export function upsertAlertRule(rule: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>): AlertRule {
  const db = getDb()
  const now = new Date().toISOString()

  const existing = db.exec(
    'SELECT * FROM dependency_alert_rules WHERE package_name = ? AND rule_type = ?',
    [rule.packageName, rule.ruleType],
  )

  if (existing.length > 0 && existing[0].values.length > 0) {
    db.run(
      `UPDATE dependency_alert_rules
       SET min_severity = ?, channel = ?, enabled = ?, updated_at = ?
       WHERE package_name = ? AND rule_type = ?`,
      [rule.minSeverity, rule.channel, rule.enabled ? 1 : 0, now, rule.packageName, rule.ruleType],
    )
  } else {
    db.run(
      `INSERT INTO dependency_alert_rules (package_name, rule_type, min_severity, channel, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [rule.packageName, rule.ruleType, rule.minSeverity, rule.channel, rule.enabled ? 1 : 0, now, now],
    )
  }

  const result = db.exec(
    'SELECT * FROM dependency_alert_rules WHERE package_name = ? AND rule_type = ?',
    [rule.packageName, rule.ruleType],
  )
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToAlertRule(row)
}

export function getAlertRules(options?: { packageName?: string; enabled?: boolean }): AlertRule[] {
  const db = getDb()
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (options?.packageName) {
    clauses.push('package_name = ?')
    params.push(options.packageName)
  }
  if (options?.enabled !== undefined) {
    clauses.push('enabled = ?')
    params.push(options.enabled ? 1 : 0)
  }

  let sql = 'SELECT * FROM dependency_alert_rules'
  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ')
  }
  sql += ' ORDER BY package_name, rule_type'

  const result = db.exec(sql, params)
  if (result.length === 0) return []
  const cols = result[0].columns
  return result[0].values.map((vals: unknown[]) => {
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })
    return rowToAlertRule(row)
  })
}

export function getAlertRule(packageName: string, ruleType: string): AlertRule | undefined {
  const db = getDb()
  const result = db.exec(
    'SELECT * FROM dependency_alert_rules WHERE package_name = ? AND rule_type = ?',
    [packageName, ruleType],
  )
  if (result.length === 0 || result[0].values.length === 0) return undefined
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToAlertRule(row)
}

export function deleteAlertRule(packageName: string, ruleType: string): boolean {
  const db = getDb()
  db.run(
    'DELETE FROM dependency_alert_rules WHERE package_name = ? AND rule_type = ?',
    [packageName, ruleType],
  )
  return db.getRowsModified() > 0
}

export async function runDependencyCheck(packageJsonContent: string): Promise<{
  deps: DependencyRecord[]
  updates: DependencyUpdate[]
  classified: ClassifiedChange[]
}> {
  const pkg = parsePackageJson(packageJsonContent)
  const deps = extractDependencies(pkg)
  const depRecords: DependencyRecord[] = []
  const updates: DependencyUpdate[] = []
  const classified: ClassifiedChange[] = []

  for (const dep of deps) {
    const resolvedVersion = resolveRangeToVersion(dep.version)
    if (!resolvedVersion) continue

    const info = await pollNpmRegistry(dep.name)

    const record = await upsertDependency({
      name: dep.name,
      currentVersion: resolvedVersion,
      latestVersion: info.latestVersion,
      type: dep.type,
    })
    depRecords.push(record)

    if (info.latestVersion !== resolvedVersion) {
      const semverDiff = compareSemver(resolvedVersion, info.latestVersion)

      const classifiedChange = classifyChange(
        dep.name,
        resolvedVersion,
        info.latestVersion,
        semverDiff,
        undefined,
        { isDirectDependency: dep.type === 'dependencies' },
      )
      classified.push(classifiedChange)

      const update = await checkForUpdates(dep.name)
      if (update) updates.push(update)
    }
  }

  return { deps: depRecords, updates, classified }
}