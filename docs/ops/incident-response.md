# Incident Response Runbook

Owner: Backend Engineer / Ops
Related: [Escalation & On-Call](escalation-and-oncall.md), [Deployment & Rollback](deployment-and-rollback.md)

Purpose: a structured procedure for diagnosing and resolving the most common
Nightlamp production failures. Every runbook follows the same shape:

1. **Symptoms** — what alerts / user reports look like.
2. **Diagnosis** — concrete checks to localize the fault.
3. **Resolution** — the fix steps.
4. **Escalation** — who to page and when.

Production endpoints:
- Backend: https://nightlamp-api.onrender.com
- Frontend: https://nightlamp-frontend.onrender.com
- Health: `GET /api/health` (self-monitoring SLO fields)

---

## 1. API Downtime

**Symptoms:** `/api/health` returns non-200, alert "Downtime > 1 min", frontend shows errors.

**Diagnosis:**
1. `curl -s -o /dev/null -w "%{http_code}" https://nightlamp-api.onrender.com/api/health`
2. Check Render deploy status (`Events` tab) — a failed/deploying commit is running.
3. Check Render logs for OOM or unhandled-exception restart loops.

**Resolution:**
1. If a bad deploy is live → [Rollback](deployment-and-rollback.md).
2. If not deployed recently → redeploy last-good image, verify health.
3. Check DB disk usage (`/data` mount) — SQLite fills up on growth.

**Escalation:** P1 (critical). Page on-call after 0 min if still down.

---

## 2. High Latency (API p95 > 500ms)

**Symptoms:** `GET /api/performance/latency` shows global p95 above target; SLO breach alert; slow dashboards.

**Diagnosis:**
1. Inspect `/api/performance/latency` per-path percentiles.
2. Check `/api/monitors` result sizes — large monitor lists under high frequency.
3. Look for un-indexed query patterns (monitor list without cache).

**Resolution:**
1. Confirm hot-path cache is active (`/api/monitors`).
2. Re-run a Lighthouse/perf audit: `npx ts-node scripts/performance-benchmark.ts <url> 5`.
3. Add/adjust indexes on hot query columns (`checks.created_at`, `failure_events.detected_at`).

**Escalation:** P2 (warning) → P1 if sustained past ~10 min.

---

## 3. Error Spike (Error rate > 1%)

**Symptoms:** Alert "error rate > 1%", failure-event rate climbing, Sentry spike.

**Diagnosis:**
1. `GET /api/events` — group by `failure_type` and `severity`.
2. Check `GET /api/check-results` for failing checks.
3. Correlate with a recent deploy (did a dependency or config change?)

**Resolution:**
1. If tied to a deploy → rollback.
2. If a single integration (Sentry/UptimeRobot) — check connector creds (see token runbook).
3. Use `POST /api/playbook/remediate` for known patterns.

**Escalation:** P1 if >1% sustained; otherwise P2.

---

## 4. Database Issues

**Symptoms:** 500s on queries, disk-full errors, slow reads.

**Diagnosis:**
1. `SELECT` latency via `/api/performance/latency`.
2. Render disk usage for `/data`.
3. Check for large `failure_events` growth (SQLite).

**Resolution:**
1. Stop writers (pause pollers) if full.
2. Compact/prune old `check_results`/`failure_events`.
3. Ensure WAL/journal safety margin on the disk.

**Escalation:** P1 (data integrity).

---

## 5. Auth Failures (Clerk)

**Symptoms:** users cannot sign in/sign up; frontend auth errors; Clerk webhook drops.

**Diagnosis:**
1. Check `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in Render envs.
2. Verify `POST /api/webhooks/clerk` is receiving events (log).
3. Confirm Clerk app published + signing keys valid.

**Resolution:**
1. Rotate Clerk keys, update Render env, redeploy.
2. Re-sync webhook URL in Clerk dashboard.

**Escalation:** P2.

---

## 6. Deployment Failure

**Symptoms:** GitHub Actions `verify`/`smoke` red on merge to main; Render failing build.

**Diagnosis:**
1. Open the Actions workflow run for the failed commit.
2. If `verify` failed → code issue; fix in a branch + PR.
3. If `smoke` failed after deploy → new build is unhealthy → rollback.

**Resolution:**
1. Fix/rollback per [Deployment & Rollback](deployment-and-rollback.md).
2. Confirm secrets exist in GitHub + Render.

**Escalation:** P2; P1 if production is affected.

---

## 7. Security Incident

**Symptoms:** leaked secrets, unexpected data access, alert from provider (Sentry/Stripe/Cloud).

**Diagnosis:**
1. Review `remediation_log`, auth logs, provider dashboards.
2. Check whether any secret has been exposed in repo history/PRs.

**Resolution:**
1. Rotate implicated secrets immediately (Stripe, Sentry, UptimeRobot, Clerk).
2. Send secrets: revoke + replace; never commit.
3. Freeze deploys until triaged.

**Escalation:** P1 — call the CTO immediately.

---

## 8. Sentry Integration Broken

**Symptoms:** stale Sentry data, poll errors in logs, no new error events.

**Diagnosis:**
1. Verify `SENTRY_AUTH_TOKEN`, `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_SLUG`.
2. Test the Sentry API token scopes (project read).

**Resolution:**
1. Regenerate the auth token in Sentry dashboard; update Render env; redeploy.
2. Confirm project slug is correct.

**Escalation:** P2.

---

## 9. UptimeRobot / Monitor Issues

**Symptoms:** missing uptime data, SSL/response issues unreported.

**Diagnosis:**
1. Verify `UPTIMEROBOT_API_KEY` in Render.
2. Check monitor list `GET /api/monitors`.

**Resolution:**
1. Renew the API key; redeploy.
2. Re-sync monitor definitions.

**Escalation:** P2.

---

## 10. Dependency / Rate-Limit Shift

**Symptoms:** an integration stops working after an upstream API change; `rate_limit_shift` or `schema_drift` events.

**Diagnosis:**
1. Check `GET /api/dependency-health`.
2. Review `docs/case-studies/*` for the recurring patterns.
3. Consult the auto-generated playbook for the failure type.

**Resolution:**
1. Pin versions / update client per playbook.
2. Apply remediation (`POST /api/playbook/remediate`).

**Escalation:** P2.

---

## On-Call Flow

1. Alert fires → escalation policy computes P1/P2/P3.
2. First escalation channel (pagerduty for P1) pages the on-call engineer (`getOnCallAt`).
3. Acknowledge within the ack timeout, or escalation advances to the next step / next responder.
4. Resolve → post an incident summary to the ops channel and, if it's a new failure pattern, ensure the playbook entry exists.

## Escalation Contacts

| Priority | Primary | Secondary |
| -------- | ------- | --------- |
| P1 | on-call (Backend Eng) | CTO |
| P2 | on-call | CTO |
| P3 | triage channel | - |

See [Escalation & On-Call](escalation-and-oncall.md) for the full policy.