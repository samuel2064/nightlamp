# Deployment & Rollback Runbook

Owner: Backend Engineer / Ops
Repo: https://github.com/samuel2064/nightlamp
Render dashboard: https://dashboard.render.com
Production backend: https://nightlamp-api.onrender.com
Production frontend: https://nightlamp-frontend.onrender.com

## Standard Deployment

Automated via GitHub Actions (`deploy.yml`) on merge to `main`:

1. `verify` job runs typecheck + full test suite + build.
2. `deploy-backend` triggers a Render deploy via API using `RENDER_API_KEY` + `RENDER_BACKEND_SERVICE_ID`.
3. `deploy-frontend` triggers the frontend service deploy.
4. `smoke` job polls `/api/health` (expect HTTP 200) and frontend `/` (expect HTTP 200).
5. `notify` posts completion to `DEPLOY_WEBHOOK_URL` (Slack/Discord).

Merge to `main` is the only standard deployment trigger. No manual steps required.

## Required GitHub Secrets

| Secret                          | Purpose                                        |
| ------------------------------- | ---------------------------------------------- |
| `RENDER_API_KEY`                | Render API token (Render dashboard → Account → API keys). |
| `RENDER_BACKEND_SERVICE_ID`     | Service id from `https://api.render.com/v1/services`. |
| `RENDER_FRONTEND_SERVICE_ID`    | Service id for the frontend service.           |
| `DEPLOY_WEBHOOK_URL`            | Optional Slack/Discord/webhook for notifications. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Used for frontend build in CI.            |
| `CLERK_SECRET_KEY`              | Used for frontend build in CI.                 |

All production secrets (Stripe, Sentry, UptimeRobot, Clerk, DB) are managed in the **Render dashboard → Environment**, never in the repo. The `/api/health` endpoint and health-check paths are configured on the relevant services.

## Staging Environment

- Use the root `render.yaml` blueprint to provision a second `nightlamp-api-staging` / `nightlamp-frontend-staging` pair pointing at a separate DB.
- A `.env.staging` example is provided; populate real secrets in Render staging env vars.
- Deploy staging from a `staging` branch via a manual workflow dispatch or a dedicated branch deploy; Render supports per-branch auto-deploy.

## Emergency Deployment

When a hotfix must ship immediately:

1. Create a branch from `main`, fix, and open a PR.
2. Merge to `main` — the automated CD pipeline runs the same verify + deploy + smoke.
3. If Render auto-deploy is off or pipeline is down, manually `Redeploy latest image` from the Render dashboard, or use the API:
   ```bash
   curl -X POST \
     "https://api.render.com/v1/services/<SERVICE_ID>/deploys" \
     -H "Authorization: Bearer <RENDER_API_KEY>" \
     -H "Content-Type: application/json" \
     -d '{}'
   ```

## Recovery Procedure: Forward Fix Only

**Rollback is not available.** The previous production build lacks the P0 authorization gate (NOC-280) and remediation fixes (NOC-274). Rolling back would re-introduce critical security vulnerabilities.

The only safe recovery path is a **forward fix**:

1. **Identify the failure**: Deployment workflow fails, smoke checks fail, or production health endpoint returns non-200.
2. **Create a fix branch from `main`**: `git checkout -b fix/<short-description> main`
3. **Apply the minimal fix**: Address the specific regression (e.g., revert the breaking change, fix the config, add the missing guard).
4. **Open a PR to `main`**: The CI `verify` job must pass (typecheck, tests, build).
5. **Merge to `main`**: The automated CD pipeline runs verify + deploy + smoke.
6. **Verify the deploy**: Backend `/api/health` returns 200, frontend `/` returns 200, key API endpoints respond correctly.
7. **Post an incident note** to the ops channel documenting the failure commit, fix commit, root cause, and time to recovery.

Target recovery time: **< 15 minutes** from fix commit to verified deploy.

## Alerting (NOC-314)

- **Deployment failure**: `alert-on-failure` job in `deploy.yml` posts to `DEPLOY_WEBHOOK_URL` on any job failure.
- **Health monitoring**: UptimeRobot monitors `/api/health` (backend) and `/` (frontend) — see `docs/ops/uptimerobot-monitor-setup.md`.
- **Error tracking**: Sentry integration available when `SENTRY_DSN` is configured in GitHub Secrets.

## Zero-Manual-Step Guarantee

Standard deployments require no manual console interaction: push to `main` → pipeline handles build, test, deploy, smoke, notify.

Forward-fix deployments follow the same automated path; the only manual step is creating the fix commit.