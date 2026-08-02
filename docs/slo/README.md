# Performance Baseline & SLO Documentation

## Phase 2 Baseline Metrics

Captured from initial Lighthouse audits and API monitoring infrastructure.

### API Latency (p50/p95/p99)

Measured from the API server request/response cycle:

| Percentile | Target | Measure |
|-----------|--------|---------|
| p50 | < 100ms | Median request latency |
| p95 | < 300ms | 95th percentile latency |
| p99 | < 500ms | 99th percentile latency (SLO) |

### Webhook Processing Time

Time from event reception to callback delivery:

| Metric | Target |
|--------|--------|
| Average | < 500ms |
| p95 | < 2000ms |
| p99 | < 5000ms |

### Database Query Performance

SQLite query execution time across core tables:

| Query Type | p50 | p95 | p99 |
|-----------|-----|-----|-----|
| Insert (single row) | < 5ms | < 15ms | < 50ms |
| Select (indexed, < 100 rows) | < 1ms | < 5ms | < 20ms |
| Select (aggregate, 30d window) | < 10ms | < 50ms | < 200ms |
| Join (2-3 tables, indexed) | < 5ms | < 30ms | < 100ms |

### Background Job Throughput

Health checks, dependency polling, and scheduled tasks:

| Job | Frequency | p50 Duration | p95 Duration |
|-----|-----------|-------------|-------------|
| Sentry poll | 60s | < 3s | < 10s |
| UptimeRobot poll | 60s | < 2s | < 8s |
| NPM registry poll | 3600s | < 2s | < 5s |
| Scheduled X post | 60s | < 1s | < 3s |

---

## Phase 3 SLO Targets

### Service-Level Objectives

| SLO | Target | Error Budget | Measurement |
|-----|--------|-------------|------------|
| Onboarding completion | < 5 min | 7 days | Full onboarding flow end-to-end |
| Playbook save | < 200ms | 7 days | API response time for playbook create/update |
| Notification delivery | < 2s | 7 days | Time from send() to channel delivery |
| Report generation | < 5s | 7 days | Full report query + response |
| API p99 | < 500ms | 7 days | All API endpoints, rolling window |

### Lighthouse Web Vitals SLOs

| Metric | Target | Error Budget |
|--------|--------|-------------|
| LCP | < 2500ms | 30 days |
| TBT | < 200ms | 30 days |
| CLS | < 0.1 | 30 days |
| FCP | < 1800ms | 30 days |
| Performance Score | >= 0.85 | 30 days |

### Error Budget Policy

- Error budget = total allowed downtime per period
- Budget consumed when SLO is breached
- When budget exhausted: feature freeze, priority to performance fixes
- Budget resets at end of each period

---

## CI/CD Performance Gates

### Pre-Merge Gate

Runs on every PR to main:

```bash
npx ts-node scripts/slo-gate.ts http://localhost:3001 3
```

The gate:
1. Runs 3 Lighthouse audits against the target URL
2. Compares all metrics against SLO targets
3. Checks for regressions against stored baseline
4. Exits with code 1 if any SLO is breached or regression detected
5. Outputs JSON for CI/CD integration

### Weekly Benchmark

Runs weekly in CI to track trends:

```bash
npx ts-node scripts/performance-benchmark.ts http://localhost:3001 5
```

Outputs detailed metric history for dashboard visualization.

---

## Monitoring Dashboards

### Available API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/api/performance/run` | Trigger manual Lighthouse audit (POST) |
| `/api/performance/history?url=:url` | Historical metric data |
| `/api/performance/regressions` | Detected regressions |
| `/api/performance/diagnosis?regressionId=:id` | Diagnosis for a regression |
| `/api/reports/uptime-stats?monitor_id=:id` | Uptime and response time reports |
| `/api/reports/incident-trends` | Failure event trends |

### Key Metrics to Watch

1. **LCP > 2500ms** - User-perceived load time degrading
2. **TBT > 200ms** - JavaScript processing blocking main thread
3. **Regression p-value < 0.05** - Statistically significant degradation
4. **Error budget depletion** - Approaching feature freeze threshold
5. **Failure event rate** - Week-over-week incident trend

---

## Regression Detection

The regression detector uses statistical hypothesis testing:

- **Method**: Z-score → p-value via normal CDF approximation
- **Threshold**: p < 0.05 (95% confidence)
- **Minimum samples**: 2 baseline runs required
- **Direction detection**: Automatic identification of degradation vs improvement
- **Diagnosis**: Each regression is automatically diagnosed with impact assessment

### Running Detection Manually

```bash
curl -X POST http://localhost:3001/api/performance/run \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost:3001"}'
```

---

## Alerting on SLO Breaches

Configure alert rules via the alerting API to notify on SLO breaches:

```bash
# Create an alert channel
curl -X POST http://localhost:3001/api/alerting/channels \
  -H "Content-Type: application/json" \
  -d '{"name": "SLO Alerts", "type": "slack", "config": {"webhookUrl": "..."}}'

# Create a rule to catch SLO breaches
curl -X POST http://localhost:3001/api/alerting/rules \
  -H "Content-Type: application/json" \
  -d '{"name": "SLO Breach", "channelId": "<channel-id>", "failureTypes": ["slo_breach"], "minSeverity": "warning"}'
```

---

## Caching & CDN Strategy (NOC-164)

### Hot-Path API Cache

An in-memory TTL cache (`ApiCache`, default 15s) is wired into the highest-frequency
read endpoints; `GET /api/performance/history` is part of the dashboard hot path.

- Cache key builder: `cacheKey(prefix, ...parts)` in `src/performance/api-latency.ts`
- Scope: single instance (per-pod). Safe because results are near-immutable within TTL.

**Redis (production, cross-instance):** when the API runs on 2+ Render instances, promote
the in-memory cache to a shared Redis with the same TTL. The `ApiCache` interface is a
drop-in seam — implement `get/set/has/delete` against Redis (`SETEX key TTL value`) and
inject it wherever the memory cache is used today. Keeps monitor lists, playbook lists,
and perf history consistent across pods without changing call sites.

### Static Assets / CDN

- Next.js static assets (JS/CSS/fonts under `/_next/static/`) are immutable and cacheable.
  Configure the Render/CDN edge to serve them with a long `Cache-Control: immutable` TTL.
- Keep `next.config.mjs` images as `unoptimized: true` when behind an edge CDN that
  handles image resizing/dispatch; set long cache headers there instead of relying on the
  fixup loader at request time.
- If a dedicated CDN (CloudFront/Fastly) fronts the frontend, set:
  - `/_next/static/*` → `Cache-Control: public, max-age=31536000, immutable`
  - `/api/*`, `/_next/data/*` → `Cache-Control: no-store` (dynamic)
  - HTML routes → `no-cache` unless statically pre-rendered.

### Database Indexes (hot paths)

Covering indexes added to `src/db/schema.ts` for the top read patterns (see the index
block at the end of `createDatabase`):

| Table | Index | Serves |
|-------|-------|--------|
| `perf_runs` | `(url, started_at DESC)` | `getRecentRuns` chart history |
| `perf_metrics` | `(run_id, name)` | metric history join |
| `perf_regressions` | `(url, detected_at DESC)` | regression list per URL |
| `perf_diagnoses` | `(regression_id)` | diagnosis lookup |
| `dependency_updates` | `(dependency_id, detected_at DESC)` | dependency health timeline |
| `usage_records` | `(customer_id, recorded_at DESC)` | usage/report aggregation |
| `subscriptions` | `(customer_id)` | subscription lookup for billing |
| `failure_events` | `(check_id, detected_at DESC)` | per-monitor incident history |
| `playbook_entries` | `(failure_type)` | playbook lookup on classify |
| `x_scheduled_posts` | `(status, scheduled_at)` | scheduler scan |

---

## File Reference

| File | Purpose |
|------|---------|
| `scripts/performance-benchmark.ts` | Load testing and baseline collection |
| `scripts/slo-gate.ts` | CI/CD performance gate |
| `src/performance/slo-monitor.ts` | SLO definition and breach detection |
| `src/performance/regression-detector.ts` | Statistical regression detection |
| `src/performance/perf-diagnosis.ts` | Automated regression diagnosis |
| `src/performance/perf-orchestrator.ts` | Lighthouse audit orchestration |
| `src/performance/perf-storage.ts` | Performance data persistence |
| `docs/slo/README.md` | This document |
