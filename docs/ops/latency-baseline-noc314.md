# NOC-314 Latency & Query Baseline

**Measurement Date:** TBD (to be run against production)
**Method:** Production API probing + SQL.js EXPLAIN QUERY PLAN
**Branch:** `ops/deployment-hardening-noc314`

## Measurement Method

### API Latency Measurement

```bash
# For each endpoint, run 10 requests and record p50, p95, p99
for endpoint in "/api/events" "/api/check-results" "/api/remediation/runs" "/api/dependencies" "/api/health"; do
  echo "Measuring $endpoint..."
  for i in {1..10}; do
    curl -s -o /dev/null -w "%{time_total}\n" "https://nightlamp-api.onrender.com$endpoint"
  done | sort -n | awk '{a[NR]=$1} END {print "p50:", a[int(0.5*NR+0.5)]; print "p95:", a[int(0.95*NR+0.5)]; print "p99:", a[int(0.99*NR+0.5)]}'
done
```

### Database Query Cost Measurement

For each hot route, extract the SQL query and run `EXPLAIN QUERY PLAN` against the production database schema:

```sql
-- Example for /api/events
EXPLAIN QUERY PLAN
SELECT id, check_id, failure_type, severity, title, description, detected_at, acknowledged
FROM failure_events fe
LEFT JOIN checks c ON fe.check_id = c.id
WHERE (c.id IS NULL OR c.enabled = 1)
  AND fe.team_id = ?
ORDER BY fe.detected_at DESC
LIMIT 50 OFFSET 0;
```

**Metrics to record:**
- `SCAN` vs `SEARCH` (full table scan vs index usage)
- Estimated rows examined
- Whether indexes are used
- Query execution time (if available)

## Hot Routes to Measure

| Route | Purpose | SQL Pattern |
|-------|---------|-------------|
| `GET /api/events` | Failure events list | JOIN failure_events + checks, tenant filter, ORDER BY + LIMIT |
| `GET /api/check-results` | Check results list | JOIN check_results + checks, tenant filter, ORDER BY + LIMIT |
| `GET /api/remediation/runs` | Remediation runs list | Filter by status + tenant, ORDER BY + LIMIT |
| `GET /api/dependencies` | Dependency list | Simple SELECT with tenant filter |
| `GET /api/health` | Self-monitor health | Multiple COUNT queries + SLO computation |

## Baseline Results Template

### API Latency (production)

| Endpoint | p50 (ms) | p95 (ms) | p99 (ms) | Sample Size | Notes |
|----------|----------|----------|----------|-------------|-------|
| /api/events | TBD | TBD | TBD | 10 | |
| /api/check-results | TBD | TBD | TBD | 10 | |
| /api/remediation/runs | TBD | TBD | TBD | 10 | |
| /api/dependencies | TBD | TBD | TBD | 10 | |
| /api/health | TBD | TBD | TBD | 10 | |

### Database Query Cost (EXPLAIN QUERY PLAN)

| Endpoint | Query | Scan/Search | Rows Est. | Index Used | Notes |
|----------|-------|-------------|-----------|------------|-------|
| /api_events | [query] | TBD | TBD | TBD | |
| /api_check-results | [query] | TBD | TBD | TBD | |
| /api_remediation/runs | [query] | TBD | TBD | TBD | |
| /api_dependencies | [query] | TBD | TBD | TBD | |
| /api_health (counts) | [queries] | TBD | TBD | TBD | |

## Worst Offenders & Fixes

**Criteria for "cheap and safe to fix":**
- Adding a missing index (no schema migration risk)
- Adjusting query structure (e.g., moving filters earlier)
- Adding LIMIT where missing
- No refactor of request path

### Offender 1: [Route]
- **Issue:** [e.g., full table scan on failure_events]
- **Fix:** [e.g., add index on (team_id, detected_at)]
- **Risk:** Low
- **Verification:** Re-run EXPLAIN QUERY PLAN

### Offender 2: [Route]
- **Issue:** [e.g., N+1 query pattern]
- **Fix:** [e.g., use JOIN instead of subquery]
- **Risk:** Low
- **Verification:** Re-run EXPLAIN QUERY PLAN

## Evidence

- [ ] Production latency measurements recorded
- [ ] EXPLAIN QUERY PLAN output for each hot route
- [ ] Two worst offenders identified and fixed (if applicable)
- [ ] Post-fix measurements confirming improvement

---

**Note:** This document will be updated with actual measurements when run against production. The CTO/CEO will need to authorize production access for the measurement run.