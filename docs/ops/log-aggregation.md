# Production Log Aggregation & Querying

Nightlamp self-monitors its own production services. This document describes
how logs are aggregated, retained, and queried so that SLO breaches and
incidents can be investigated post-hoc.

## Sources

| Source | Channel | Cardinality |
|--------|---------|-------------|
| API server request logs | JSON lines appended to `logs/api.log` with `{ ts, path, status, latencyMs }` | per-request |
| Alert dispatch log | `alert_log` table (server-side) | per-alert |
| Failure events | `failure_events` table (server-side) | per-incident |
| Check results | `check_results` table (server-side) | per-check |
| Background pollers (Sentry/UptimeRobot/NPM) | structured logs under `logs/pollers/*.log` | per-poll |

## Log Layout

All services write one JSON object per line to the paths below so they can be
shipped to any aggregator (`jq`, Logstash, Loki, CloudWatch) unchanged.

```text
logs/
  api.log                 # HTTP request lifecycle
  poller-sentry.log       # Sentry connector poll results
  poller-uptimerobot.log  # UptimeRobot poll results
  scheduler.log           # cron / routine dispatch
  error.log             # unhandled errors + stack traces
  audit.log             # check/remediation actions (immutable)
```

## Structured Line Example

```json
{"ts":"2026-08-02T14:15:30.816Z","level":"warn","scope":"api","method":"GET","path":"/api/alerting/self-monitor","status":200,"latencyMs":38}
```

## Querying

### Local (jq)

```bash
# Top slow endpoints in the last hour
cat logs/api.log | jq -r 'select(.level=="warn") | [.path,.latencyMs] | @tsv' | sort -k2 -nr | head -20
```

### Server-side (SQL)

The API server already exposes useful rollups:

- `GET /api/alerting/self-monitor` — real-time SLO status (error rate, p95 latency, downtime)
- `GET /api/alerting/log` — alert dispatch history
- `GET /api/incidents` — recent failure events
- `GET /api/activity` — merged recent check results + events + dependency updates

```bash
# 24h error rate from the API
curl -s http://localhost:3001/api/alerting/self-monitor | jq '.slos[] | select(.key=="error_rate")'
```

## Retention & Shipping

- Default local retention: 7 days of rotation for JSON logs (logrotate daily, keep 7).
- Structured event tables (`failure_events`, `check_results`) are retained indefinitely
  for SLO/error-budget accounting; only `raw_data` blobs are pruned after 90 days.
- To route to a remote sink at Render, sidecar the app with a log-shipper
  (vector/loki-promtail) reading `logs/` and forwarding to the aggregator, setting
  `LOG_SHIP_URL` + `LOG_SHIP_TOKEN` in production config. The main app is
  log-agnostic: any aggregator can tail the JSON files.

## Grafana Wiring

- Graph your `latencyMs` from `logs/api.log` into a Grafana time-series panel,
  p95 aggregate panel with alert threshold at `500ms`.
- Add a stat panel over `failure_events` (severity=critical) to drive the
  "downtime" SLO; alert when consecutive downtime exceeds 60s.
- Filter alerts through the escalation policy in `docs/ops/escalation-and-oncall.md`.