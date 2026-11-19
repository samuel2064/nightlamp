# Deployment Hardening Plan (NOC-160)

**Owner:** Platform Engineer  
**Status:** Draft  
**Target:** Harden deployment pipeline, monitoring, performance, and rollback procedures

---

## Current State Assessment

### ✅ Already Implemented
- **CI Pipeline** (`ci.yml`): Typecheck, lint, test, build on PR/push to main
- **CD Pipeline** (`deploy.yml`): Verify → Deploy Backend → Deploy Frontend → Smoke Tests → Notify
- **Smoke Tests**: Backend `/api/health`, auth gate (`/api/events`), Frontend `/`, `/dashboard`, `/dashboard/playbooks`, `/api/trpc/health.status`, `/api/health`
- **Rollback Procedure**: Documented in `deployment-and-rollback.md` (target < 5 min via Render dashboard)
- **Health Checks**: `/api/health` with SLO fields, `/api/alerting/self-monitor`
- **Alerting**: Escalation policies (P1/P2/P3), on-call rotation
- **Log Structure**: JSON lines for API, pollers, errors, audit
- **Incident Response**: 10 runbooks covering common failure modes

### ❌ Gaps to Address
1. **No Remote Log Aggregation** - Logs only local (7-day rotation), no Loki/CloudWatch/Grafana Cloud
2. **No Proactive Performance Monitoring** - Only reactive via incident response
3. **No Deploy Metrics/Tracking** - No deployment frequency, lead time, change failure rate tracking
4. **No Staging Environment** - `render.yaml` only defines production; staging blueprint not deployed
5. **No Canary/Blue-Green Deploy** - Direct deploy to production
6. **No Automated Rollback on Smoke Failure** - Manual rollback only
7. **No Dependency Update Automation** - `dependency-upgrades.md` exists but no scheduled automation
8. **No Secret Rotation Automation** - Manual rotation only
9. **No Deploy Freeze Windows** - No maintenance windows defined

---

## Hardening Plan

### Phase 1: Observability & Monitoring (Week 1)

#### 1.1 Remote Log Aggregation
- **Action**: Deploy Loki + Promtail sidecar on Render or ship to Grafana Cloud
- **Config**: Add `LOG_SHIP_URL`, `LOG_SHIP_TOKEN` to Render env vars
- **Verify**: Query logs in Grafana within 5 min of deploy

#### 1.2 Deploy Metrics Dashboard
- **Metrics to Track**:
  - Deployment frequency (deployments/day)
  - Lead time (commit → production)
  - Change failure rate (% deployments causing incidents)
  - Mean time to recovery (MTTR)
- **Implementation**: GitHub Actions workflow to push metrics to Grafana Cloud / Prometheus Pushgateway

#### 1.3 Real-time API Health Dashboard
- **Panels**: 
  - Request rate, error rate, latency (p50/p95/p99)
  - SLO status (error_rate, p95_latency, downtime)
  - Active alerts by priority
- **Alert Rules**: 
  - Error rate > 1% for 5m → P1
  - p95 latency > 500ms for 10m → P2
  - Downtime > 1m → P1

### Phase 2: Deployment Safety (Week 2)

#### 2.1 Staging Environment
- **Action**: Deploy `render.yaml` blueprint to create `nightlamp-api-staging` + `nightlamp-frontend-staging`
- **Secrets**: Separate Clerk app, Stripe test keys, test DB
- **Trigger**: Auto-deploy from `staging` branch or manual workflow dispatch

#### 2.2 Automated Rollback on Smoke Failure
- **Current**: Smoke fails → notify only
- **Target**: Smoke fails → auto-trigger Render rollback to previous deploy
- **Implementation**: Add `rollback-on-failure` job in `deploy.yml` that calls Render API to redeploy previous commit

#### 2.3 Pre-deploy Gate Checks
- **Add to `verify` job**:
  - Bundle size check (frontend) - fail if > threshold
  - Dependency audit (`npm audit --audit-level=high`)
  - License check (no GPL/AGPL)
  - SBOM generation

### Phase 3: Performance Optimization (Week 3)

#### 3.1 Proactive Performance Monitoring
- **Scheduled Lighthouse CI**: Run weekly against production `/dashboard`, `/onboarding`
- **Thresholds**: LCP < 2.5s, TBT < 200ms, CLS < 0.1
- **Alert**: SLO breach → P2 incident

#### 3.2 Database Performance
- **Indexes**: Add indexes on hot query columns (`checks.created_at`, `failure_events.detected_at`, `check_results.check_id`)
- **Connection Pooling**: Not applicable (SQLite), but monitor `/data` disk usage
- **Pruning**: Automated pruning of `check_results` > 90 days, `failure_events.raw_data` > 90 days

#### 3.3 Frontend Performance
- **Bundle Analysis**: Add `@next/bundle-analyzer` to CI
- **Code Splitting**: Verify dynamic imports for heavy pages (playbooks, settings)
- **Caching**: Add `Cache-Control` headers for static assets

### Phase 4: Operational Excellence (Week 4)

#### 4.1 Dependency Update Automation
- **Schedule**: Weekly PR via Dependabot or Renovate
- **Policy**: Auto-merge patch/minor if tests pass; major requires review
- **Testing**: Run full test suite + smoke test on dependency PRs

#### 4.2 Secret Rotation
- **Schedule**: Quarterly rotation for Stripe, Sentry, UptimeRobot, Clerk
- **Process**: Generate new → update Render env → deploy → verify → revoke old
- **Automation**: Script in `scripts/rotate-secrets.ts`

#### 4.3 Deploy Freeze Windows
- **Windows**: Fri 17:00 - Mon 09:00 UTC (no non-emergency deploys)
- **Override**: Manual workflow dispatch with `emergency: true` label
- **Communication**: Post to `#deployments` Slack channel

#### 4.4 Runbook Drills
- **Frequency**: Monthly
- **Scenarios**: API downtime, high latency, error spike, auth failure
- **Tracking**: Document MTTR, gaps, improvements

---

## Acceptance Criteria

| Criterion | Target | Verification |
|-----------|--------|--------------|
| Remote logs queryable | < 5 min latency | Grafana query returns recent logs |
| Deploy metrics tracked | 100% of deploys | Dashboard shows last 30 deploys |
| Staging environment live | Accessible | `https://nightlamp-api-staging.onrender.com/api/health` returns 200 |
| Auto-rollback on smoke fail | < 3 min | Simulated bad deploy rolls back automatically |
| Lighthouse CI runs | Weekly | GitHub Actions shows weekly run |
| Dependency PRs auto-created | Weekly | Dependabot/Renovate PRs visible |
| Secret rotation documented | Quarterly | `SECRET_ROTATION_LOG.md` updated |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Log shipper fails silently | No visibility | Health check on shipper; alert on missing logs |
| Auto-rollback triggers falsely | Unnecessary rollback | Require 2 consecutive smoke failures |
| Staging env diverges from prod | False confidence | Same Dockerfile, same render.yaml blueprint |
| Performance regression missed | User impact | Lighthouse CI + API latency SLO alerts |

---

## Next Steps

1. **Review with CTO** - Confirm priorities and timeline
2. **Provision Grafana Cloud / Loki** - For log aggregation
3. **Deploy staging environment** - Via `render.yaml` blueprint
4. **Implement auto-rollback** - Modify `deploy.yml`
5. **Add Lighthouse CI** - New workflow file
6. **Configure Dependabot/Renovate** - For dependency automation