import { getDb } from '../db.js'

export type PlaybookSeverity = 'critical' | 'high' | 'medium' | 'low'
export type PlaybookStatus = 'open' | 'investigating' | 'resolved' | 'dismissed'

export interface PlaybookEntry {
  id?: number
  failureType: string
  source: string
  severity: PlaybookSeverity
  title: string
  description: string
  affectedResource: string
  diagnosis: string
  remediation: string
  status: PlaybookStatus
  occurrenceCount: number
  firstDetectedAt: string
  lastDetectedAt: string
  resolvedAt?: string
  relatedEntries?: string
  createdAt?: string
  updatedAt?: string
}

export interface CreatePlaybookEntry {
  failureType: string
  source: string
  severity: PlaybookSeverity
  title: string
  description: string
  affectedResource: string
  diagnosis: string
  remediation: string
  relatedEntries?: string
}

function rowToPlaybookEntry(row: Record<string, unknown>): PlaybookEntry {
  return {
    id: row.id as number,
    failureType: row.failure_type as string,
    source: row.source as string,
    severity: row.severity as PlaybookSeverity,
    title: row.title as string,
    description: row.description as string,
    affectedResource: row.affected_resource as string,
    diagnosis: row.diagnosis as string,
    remediation: row.remediation as string,
    status: row.status as PlaybookStatus,
    occurrenceCount: row.occurrence_count as number,
    firstDetectedAt: row.first_detected_at as string,
    lastDetectedAt: row.last_detected_at as string,
    resolvedAt: row.resolved_at as string | undefined,
    relatedEntries: row.related_entries as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export function resetPlaybooks(): void {
  getDb().run('DELETE FROM playbook_entries')
}

export function createPlaybookEntry(input: CreatePlaybookEntry): PlaybookEntry {
  const db = getDb()
  const now = new Date().toISOString()

  const existing = db.exec(
    'SELECT * FROM playbook_entries WHERE failure_type = ? AND source = ?',
    [input.failureType, input.source],
  )

  if (existing.length > 0 && existing[0].values.length > 0) {
    const cols = existing[0].columns
    const vals = existing[0].values[0]
    const row: Record<string, unknown> = {}
    cols.forEach((c: string, i: number) => { row[c] = vals[i] })

    const occurrenceCount = (row.occurrence_count as number) + 1
    db.run(
      `UPDATE playbook_entries
       SET severity = ?, description = ?, diagnosis = ?, remediation = ?,
           occurrence_count = ?, last_detected_at = ?, updated_at = ?
       WHERE failure_type = ? AND source = ?`,
      [input.severity, input.description, input.diagnosis, input.remediation,
       occurrenceCount, now, now, input.failureType, input.source],
    )

    const result = db.exec(
      'SELECT * FROM playbook_entries WHERE failure_type = ? AND source = ?',
      [input.failureType, input.source],
    )
    const rCols = result[0].columns
    const rVals = result[0].values[0]
    const rRow: Record<string, unknown> = {}
    rCols.forEach((c: string, i: number) => { rRow[c] = rVals[i] })
    return rowToPlaybookEntry(rRow)
  }

  db.run(
    `INSERT INTO playbook_entries
     (failure_type, source, severity, title, description, affected_resource,
      diagnosis, remediation, status, occurrence_count, first_detected_at,
      last_detected_at, related_entries, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?)`,
    [input.failureType, input.source, input.severity, input.title,
     input.description, input.affectedResource, input.diagnosis,
     input.remediation, now, now, input.relatedEntries || null, now, now],
  )

  const result = db.exec(
    'SELECT * FROM playbook_entries WHERE failure_type = ? AND source = ?',
    [input.failureType, input.source],
  )
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToPlaybookEntry(row)
}

export function getPlaybookEntry(id: number): PlaybookEntry | undefined {
  const result = getDb().exec('SELECT * FROM playbook_entries WHERE id = ?', [id])
  if (result.length === 0 || result[0].values.length === 0) return undefined
  const cols = result[0].columns
  const vals = result[0].values[0]
  const row: Record<string, unknown> = {}
  cols.forEach((c: string, i: number) => { row[c] = vals[i] })
  return rowToPlaybookEntry(row)
}

export function getPlaybookEntries(options?: {
  source?: string
  severity?: PlaybookSeverity
  status?: PlaybookStatus
  limit?: number
  offset?: number
}): PlaybookEntry[] {
  const db = getDb()
  const clauses: string[] = []
  const params: (number | string)[] = []

  if (options?.source) {
    clauses.push('source = ?')
    params.push(options.source)
  }
  if (options?.severity) {
    clauses.push('severity = ?')
    params.push(options.severity)
  }
  if (options?.status) {
    clauses.push('status = ?')
    params.push(options.status)
  }

  let sql = 'SELECT * FROM playbook_entries'
  if (clauses.length > 0) {
    sql += ' WHERE ' + clauses.join(' AND ')
  }
  sql += ' ORDER BY last_detected_at DESC'

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
    return rowToPlaybookEntry(row)
  })
}

export function updatePlaybookStatus(id: number, status: PlaybookStatus, resolvedAt?: string): PlaybookEntry | undefined {
  const db = getDb()
  const now = new Date().toISOString()

  if (status === 'resolved') {
    db.run(
      'UPDATE playbook_entries SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?',
      [status, resolvedAt || now, now, id],
    )
  } else {
    db.run(
      'UPDATE playbook_entries SET status = ?, updated_at = ? WHERE id = ?',
      [status, now, id],
    )
  }

  return getPlaybookEntry(id)
}

export function getPlaybooksBySource(source: string): PlaybookEntry[] {
  return getPlaybookEntries({ source })
}

export function deletePlaybookEntry(id: number): boolean {
  const db = getDb()
  db.run('DELETE FROM playbook_entries WHERE id = ?', [id])
  return db.getRowsModified() > 0
}