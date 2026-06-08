import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Database } from 'sql.js';
import { FailureType } from '../classifier';

export interface PlaybookEntry {
  id: string;
  failureType: FailureType;
  title: string;
  body: string;
  firstSeenAt: string;
  lastOccurrenceAt: string;
  occurrenceCount: number;
}

const PLAYBOOK_TEMPLATES: Record<FailureType, { title: string; body: string }> = {
  broken_webhook: {
    title: 'Broken Webhook Investigation',
    body: `## Broken Webhook\n\n### Symptoms\n- 5xx responses from callback URL\n- Missing or delayed webhook deliveries\n\n### Diagnostic Steps\n1. Verify webhook endpoint is reachable: \`curl -I <callback_url>\`\n2. Check webhook secret matches integration configuration\n3. Review webhook delivery logs in provider dashboard\n4. Test with a manual payload using the provider's test tool\n\n### Resolution\n- If endpoint is down: restart service and verify health endpoint\n- If secret mismatch: rotate webhook secret and update both sides\n- If payload format changed: compare with provider's latest API docs\n`,
  },
  expired_token: {
    title: 'Expired Token Investigation',
    body: `## Expired Token\n\n### Symptoms\n- 401/403 responses from API calls\n- Error messages mentioning "expired", "invalid token", or "unauthorized"\n\n### Diagnostic Steps\n1. Check token expiry date in provider dashboard\n2. Verify token is correctly set in environment variables\n3. Test token manually: \`curl -H "Authorization: Bearer <token>" <api_endpoint>\`\n4. Check if token was revoked or rotated\n\n### Resolution\n- Generate new token from provider dashboard\n- Update environment variable and restart service\n- If using short-lived tokens, implement token refresh logic\n`,
  },
  schema_drift: {
    title: 'Schema Drift Investigation',
    body: `## Schema Drift\n\n### Symptoms\n- Unexpected fields or missing fields in API responses\n- Parsing errors when processing integration data\n\n### Diagnostic Steps\n1. Compare current response structure against expected schema\n2. Check provider changelog for API version updates\n3. Verify API version parameter in request\n4. Log raw response for inspection\n\n### Resolution\n- Update data models to match new schema\n- Pin API version if provider supports versioning\n- Add defensive parsing with fallbacks for optional fields\n`,
  },
  rate_limit_shift: {
    title: 'Rate Limit Shift Investigation',
    body: `## Rate Limit Shift\n\n### Symptoms\n- HTTP 429 responses from API\n- Headers indicating rate limit exceeded\n\n### Diagnostic Steps\n1. Check rate limit headers: \`X-RateLimit-Remaining\`, \`X-RateLimit-Reset\`\n2. Review recent API call volume vs. documented limits\n3. Check if other services using same API key\n\n### Resolution\n- Reduce poll frequency or batch requests\n- Implement exponential backoff with jitter\n- Upgrade API plan if hitting hard limits\n- Distribute load across multiple API keys if supported\n`,
  },
  error_spike: {
    title: 'Error Spike Investigation',
    body: `## Error Spike\n\n### Symptoms\n- Sudden increase in error count in Sentry\n- Multiple users reporting same issue\n\n### Diagnostic Steps\n1. Review Sentry issue details for stack traces and affected versions\n2. Check recent deployments that may have introduced the error\n3. Verify upstream dependencies are healthy\n4. Check database connection pool and query performance\n\n### Resolution\n- Roll back recent deployment if correlated\n- Hotfix the identified code path\n- Add additional error handling and monitoring\n`,
  },
  new_error_pattern: {
    title: 'New Error Pattern Investigation',
    body: `## New Error Pattern\n\n### Symptoms\n- First occurrence of an error type in Sentry\n- No prior history of this error in the project\n\n### Diagnostic Steps\n1. Review full stack trace in Sentry\n2. Identify affected code path and recent changes\n3. Check if this is related to a dependency update\n4. Reproduce locally with similar conditions\n\n### Resolution\n- Create a bug ticket with reproduction steps\n- Add monitoring for this error pattern\n- Fix and deploy hotfix or include in next sprint\n`,
  },
  remediation_triggered: {
    title: 'Auto-Remediation Triggered Investigation',
    body: `## Auto-Remediation Triggered\n\n### Symptoms\n- Repeated occurrence of a known failure pattern (2+ times)\n- Auto-remediation script was executed automatically\n\n### Diagnostic Steps\n1. Check remediation log for script output and status\n2. Verify remediation resolved the issue on next check cycle\n3. If remediation failed, review script output for errors\n\n### Resolution\n- If remediation succeeded: no action needed, monitor next cycle\n- If remediation failed: manually investigate using the primary playbook entry\n- Consider updating remediation script parameters\n`,
  },
};

export function getOrCreatePlaybookEntry(db: Database, failureType: FailureType): PlaybookEntry {
  const existing = db.exec(
    `SELECT id, failure_type, title, body, first_seen_at, last_occurrence_at, occurrence_count FROM playbook_entries WHERE failure_type = ?`,
    [failureType]
  );

  if (existing.length > 0 && existing[0].values.length > 0) {
    const row = existing[0].values[0];
    const entry: PlaybookEntry = {
      id: row[0] as string,
      failureType: row[1] as FailureType,
      title: row[2] as string,
      body: row[3] as string,
      firstSeenAt: row[4] as string,
      lastOccurrenceAt: row[5] as string,
      occurrenceCount: (row[6] as number) + 1,
    };

    db.run(
      `UPDATE playbook_entries SET last_occurrence_at = datetime('now'), occurrence_count = ? WHERE id = ?`,
      [entry.occurrenceCount, entry.id]
    );

    return entry;
  }

  const template = PLAYBOOK_TEMPLATES[failureType] || {
    title: `Unknown Failure: ${failureType}`,
    body: `## Unknown Failure Type\n\nNo diagnostic template available for "${failureType}".\n`,
  };

  const id = uuidv4();
  const now = new Date().toISOString();

  db.run(
    `INSERT INTO playbook_entries (id, failure_type, title, body, first_seen_at, last_occurrence_at, occurrence_count) VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [id, failureType, template.title, template.body, now, now]
  );

  return {
    id,
    failureType,
    title: template.title,
    body: template.body,
    firstSeenAt: now,
    lastOccurrenceAt: now,
    occurrenceCount: 1,
  };
}

export function writePlaybookFile(playbookDir: string, entry: PlaybookEntry): string {
  if (!fs.existsSync(playbookDir)) {
    fs.mkdirSync(playbookDir, { recursive: true });
  }

  const filename = `${entry.failureType}.md`;
  const filePath = path.join(playbookDir, filename);

  const content = `# ${entry.title}

- **First seen:** ${entry.firstSeenAt}
- **Last occurrence:** ${entry.lastOccurrenceAt}
- **Occurrence count:** ${entry.occurrenceCount}

${entry.body}
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}