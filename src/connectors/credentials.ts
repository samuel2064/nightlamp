import { SentryConfig } from './sentry';
import { UptimeRobotConfig } from './uptimerobot';

/**
 * Credentials copied from `.env.example` or a scaffolded deployment are
 * placeholders, not real secrets. Polling with them produces permanent
 * "invalid api_key" / "404 Not Found" criticals that drown out real failures,
 * so integrations must refuse to run until they are replaced.
 */
const PLACEHOLDER_MARKERS = ['your', 'placeholder', 'changeme', 'change-me', 'example', 'dummy', 'sample', 'xxx', '...'];

export function isPlaceholderCredential(value: string | null | undefined): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker));
}

export function isSentryConfigPlaceholder(config: Partial<SentryConfig> | null | undefined): boolean {
  if (!config) return true;
  return (
    isPlaceholderCredential(config.authToken) ||
    isPlaceholderCredential(config.orgSlug) ||
    isPlaceholderCredential(config.projectSlug)
  );
}

export function isUptimeRobotConfigPlaceholder(config: Partial<UptimeRobotConfig> | null | undefined): boolean {
  if (!config) return true;
  return isPlaceholderCredential(config.apiKey);
}
