import { Database } from 'sql.js';

export interface MatchResult {
  id: string;
  failureType: string;
  title: string;
  snippet: string;
  firstSeenAt: string;
  lastOccurrenceAt: string;
  occurrenceCount: number;
  severity: string;
  confidence: number;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4,
  warning: 3,
  info: 2,
};

export function matchPlaybookEntries(
  db: Database,
  symptoms: string,
  limit: number = 20,
): MatchResult[] {
  const query = symptoms.toLowerCase().trim();
  if (!query) return [];

  const terms = query.split(/\s+/).filter(Boolean);
  const likeClauses = terms.map(() => `(LOWER(f.title) LIKE ? OR LOWER(f.body) LIKE ? OR LOWER(f.failure_type) LIKE ?)`);
  const likeParams: string[] = [];
  for (const term of terms) {
    const pattern = `%${term}%`;
    likeParams.push(pattern, pattern, pattern);
  }

  const sql = `
    SELECT f.id, f.failure_type, f.title, f.body, f.first_seen_at, f.last_occurrence_at, f.occurrence_count,
           COALESCE(e.severity, 'warning') as severity
    FROM playbook_entries f
    LEFT JOIN (
      SELECT failure_type, severity, MAX(detected_at) as max_detected
      FROM failure_events
      GROUP BY failure_type
    ) latest ON f.failure_type = latest.failure_type
    LEFT JOIN failure_events e ON e.failure_type = latest.failure_type AND e.detected_at = latest.max_detected
    WHERE ${likeClauses.join(' AND ')}
    ORDER BY f.occurrence_count DESC
    LIMIT ?
  `;

  const result = db.exec(sql, [...likeParams, limit]);

  if (result.length === 0 || result[0].values.length === 0) return [];

  const matches: MatchResult[] = result[0].values.map((row: any) => {
    const id = row[0] as string;
    const failureType = row[1] as string;
    const title = row[2] as string;
    const body = row[3] as string;
    const firstSeenAt = row[4] as string;
    const lastOccurrenceAt = row[5] as string;
    const occurrenceCount = row[6] as number;
    const severity = row[7] as string;

    const confidence = calculateConfidence(query, terms, title, body, failureType, occurrenceCount, severity);

    return {
      id,
      failureType,
      title,
      snippet: extractSnippet(body, query, 200),
      firstSeenAt,
      lastOccurrenceAt,
      occurrenceCount,
      severity,
      confidence: Math.round(confidence * 100) / 100,
    };
  });

  return matches.sort((a, b) => b.confidence - a.confidence);
}

function calculateConfidence(
  query: string,
  terms: string[],
  title: string,
  body: string,
  failureType: string,
  occurrenceCount: number,
  severity: string,
): number {
  let score = 0;
  const titleLower = title.toLowerCase();
  const bodyLower = body.toLowerCase();
  const typeLower = failureType.toLowerCase();

  for (const term of terms) {
    if (titleLower.includes(term)) score += 0.35;
    if (bodyLower.includes(term)) score += 0.2;
    if (typeLower.includes(term)) score += 0.3;
  }

  if (titleLower === query) score += 0.15;
  if (typeLower === query.replace(/\s+/g, '_')) score += 0.1;

  const occurrenceBonus = Math.min(occurrenceCount / 10, 0.1);
  score += occurrenceBonus;

  const sev = (SEVERITY_ORDER[severity] || 1) / 10;
  score += sev;

  return Math.min(score, 1.0);
}

function extractSnippet(body: string, query: string, maxLen: number): string {
  const lowerBody = body.toLowerCase();
  const idx = lowerBody.indexOf(query.toLowerCase());
  if (idx === -1) return body.substring(0, maxLen);

  const start = Math.max(0, idx - 60);
  const end = Math.min(body.length, idx + query.length + 80);
  let snippet = body.substring(start, end);

  if (start > 0) snippet = '...' + snippet;
  if (end < body.length) snippet = snippet + '...';

  if (snippet.length > maxLen) {
    snippet = snippet.substring(0, maxLen) + '...';
  }
  return snippet;
}

export function getCorrelatedPatterns(
  db: Database,
  failureType: string,
  limit: number = 5,
): { failureType: string; coOccurrenceCount: number }[] {
  const result = db.exec(
    `SELECT e2.failure_type, COUNT(*) as co_count
     FROM failure_events e1
     JOIN failure_events e2 ON e1.check_id = e2.check_id AND e1.failure_type != e2.failure_type
     WHERE e1.failure_type = ?
     GROUP BY e2.failure_type
     ORDER BY co_count DESC
     LIMIT ?`,
    [failureType, limit],
  );

  if (result.length === 0 || result[0].values.length === 0) return [];

  return result[0].values.map((row: any) => ({
    failureType: row[0] as string,
    coOccurrenceCount: row[1] as number,
  }));
}