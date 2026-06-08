import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';

export interface SentryConfig {
  authToken: string;
  orgSlug: string;
  projectSlug: string;
}

export interface SentryIssue {
  id: string;
  title: string;
  level: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  culprit: string;
  isNew: boolean;
}

export interface SentryPollResult {
  issues: SentryIssue[];
  error: string | null;
}

export async function pollSentry(config: SentryConfig): Promise<SentryPollResult> {
  try {
    const url = `https://sentry.io/api/0/projects/${config.orgSlug}/${config.projectSlug}/issues/`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.authToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return { issues: [], error: `Sentry API returned ${response.status}: ${response.statusText}` };
    }

    const data = await response.json() as any[];
    const issues: SentryIssue[] = data.map((item: any) => ({
      id: item.id,
      title: item.title,
      level: item.level,
      count: item.count,
      firstSeen: item.firstSeen,
      lastSeen: item.lastSeen,
      permalink: item.permalink,
      culprit: item.culprit,
      isNew: !item.count || item.count <= 1,
    }));

    return { issues, error: null };
  } catch (err: any) {
    return { issues: [], error: `Sentry poll failed: ${err.message}` };
  }
}

export function detectSpikes(
  current: SentryIssue[],
  previous: SentryIssue[],
  threshold: number = 5
): SentryIssue[] {
  const prevMap = new Map(previous.map((p) => [p.id, p]));
  return current.filter((issue) => {
    const prev = prevMap.get(issue.id);
    if (!prev) return false;
    return issue.count >= prev.count * threshold;
  });
}

export function detectNewPatterns(current: SentryIssue[], previous: SentryIssue[]): SentryIssue[] {
  const prevIds = new Set(previous.map((p) => p.id));
  return current.filter((issue) => !prevIds.has(issue.id));
}