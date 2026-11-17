# Background monitor tenant ownership

The environment-configured Sentry and UptimeRobot monitors each have one owner.
Set `SENTRY_TEAM_ID` and `UPTIMEROBOT_TEAM_ID` to existing internal `teams.id`
values; `MONITOR_TEAM_ID` is an optional common fallback. An unset value means
personal/platform scope. A monitor with an unknown configured team ID is disabled. The
current environment-based scheduler supports one configured monitor per source;
it does not yet provide per-team connector provisioning or multiple instances.

Check identity includes the team, source and name. Results, failure events,
playbook entries and alert evaluation inherit that owner. Platform self-monitor
events remain personal and cannot trigger team-owned rules.

## Existing rows

There is no automatic ownership backfill: existing `team_id IS NULL` checks,
results and events stay in personal scope and are excluded from tenant
dashboards and tenant alert rules. Configuring an owner creates a distinct
team-owned check for future polls; it does not claim historical data. Operators
must establish ownership before any separately planned historical migration.
