# NOC-314 Operational Debt List

**Created:** 2026-11-18
**Branch:** `ops/deployment-hardening`
**Owner:** Platform Engineer

## Deployment Risks

| # | Risk | Impact | Likelihood | Mitigation | Owner |
|---|------|--------|------------|------------|-------|
| 1 | **Rollback unavailable** - Previous build lacks P0 auth gate | Critical security regression if rollback attempted | High (if emergency rollback needed) | Forward-fix only procedure documented; automated CI/CD ensures fast forward-fix deploy | Platform Engineer |
| 2 | **No deployment failure alerting** - Failed deploys only visible in GitHub Actions | Delayed detection of broken production | Medium | Configure Sentry/GitHub Actions webhook to alert on workflow failure | Platform Engineer |
| 3 | **Health endpoint not monitored externally** - No UptimeRobot monitor on `/api/health` | Outage detection relies on customer reports | High | Add UptimeRobot monitor for `https://nightlamp-api.onrender.com/api/health` | Platform Engineer |
| 4 | **Frontend health not monitored** - Only backend health probed in smoke test | Frontend deployment failures may go undetected | Medium | Add frontend `/api/health` and `/dashboard` probes to smoke test | Platform Engineer |
| 5 | **Database migration risk** - Schema changes require manual coordination | Failed migration = downtime | Low (rare) | Document migration procedure; test in staging; maintain backward-compatible SQL | Backend Engineer |
| 6 | **Secrets rotation not automated** - Clerk, Stripe, Render keys rotated manually | Expired secrets cause outages | Medium | Document rotation schedule; add calendar reminders; consider secret manager | Platform Engineer |
| 7 | **No staging environment parity** - Staging DB separate but not regularly synced | Staging may not catch production issues | Medium | Document staging sync procedure; run integration tests against staging | Backend Engineer |
| 8 | **Single-region deployment** - Render free tier = single region | Regional outage = total outage | Low | Document disaster recovery; evaluate multi-region when budget allows | CTO |
| 9 | **Cold start on free tier** - Backend spins down after inactivity | First request after idle = high latency / timeout | High (on free tier) | Document in runbook; consider paid tier for production; health check keeps warm | Platform Engineer |
| 10 | **No automated dependency update testing** - Renovate PRs not tested against full suite | Breaking dependency changes may merge | Medium | Configure Renovate to run full test suite on PRs | Backend Engineer |

## Technical Debt (Non-Deployment)

| # | Debt | Impact | Mitigation | Owner |
|---|------|--------|------------|-------|
| 11 | **SQL.js in-memory DB** - Not suitable for high-write production | Scaling limit, persistence risk | Plan migration to PostgreSQL | Backend Engineer |
| 12 | **No distributed tracing** - Hard to debug cross-service latency | Debugging difficulty | Add OpenTelemetry when budget allows | Platform Engineer |
| 13 | **Frontend error boundaries incomplete** - Some errors crash entire page | Poor UX on errors | Add error boundaries to all page components | Frontend Engineer |

## Immediate Actions (This Sprint)

| # | Action | Owner | Due |
|---|--------|-------|-----|
| 1 | Add UptimeRobot monitor for backend `/api/health` | Platform Engineer | This sprint |
| 2 | Add GitHub Actions failure webhook to alerting | Platform Engineer | This sprint |
| 3 | Document forward-fix runbook (DONE) | Platform Engineer | Complete |
| 4 | Measure latency baseline (template created) | Platform Engineer | Next sprint |

## Configuration Required (CTO/CEO Action)

The following require production configuration changes that Platform Engineer cannot make:

| Config | Service | Required For | Request To |
|--------|---------|--------------|------------|
| `UPTIMEROBOT_API_KEY` | Render env (backend) | UptimeRobot monitoring | CTO/CEO |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_SLUG` | Render env (backend) | Sentry error tracking | CTO/CEO |
| `DEPLOY_WEBHOOK_URL` | GitHub Secrets | Deploy notifications | CTO/CEO |
| Staging environment provisioning | Render | Staging parity | CTO/CEO |

---

**Evidence:** This document serves as the operational debt list required by NOC-314 acceptance criteria.