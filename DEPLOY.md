# Nightlamp Backend — Deployment Guide

## Architecture

Single Node.js (Express) service, port 3000, compiled TypeScript.
SQLite database via Docker volume, Redis for optional caching.
Dockerfile + docker-compose.yml ready for containerized deployment.

## Prerequisites

- Docker & Docker Compose v2 on target host
- GitHub Container Registry (or Docker Hub) access
- API keys (see [.env.example](.env.example)):
  - Stripe (test mode)
  - Sentry DSN
  - UptimeRobot API key + monitor ID

## CI/CD Pipeline

GitHub Actions workflow (`.github/workflows/docker-publish.yml`):
1. **Test**: `npm ci` → `tsc --noEmit` → `vitest run`
2. **Publish** (main only): build & push Docker image to GHCR
3. Artifact tags: `latest`, `sha-{commit}`, `main`

## Manual Deploy

```bash
# 1. Build image
docker build -t ghcr.io/nightlamp/monitoring:latest .

# 2. Push to registry
docker push ghcr.io/nightlamp/monitoring:latest

# 3. On target host — pull & restart
docker pull ghcr.io/nightlamp/monitoring:latest
docker compose up -d --pull always
```

Or use the deploy script:

```bash
export TARGET_HOST=user@staging.example.com
./deploy.sh
```

## Environment Setup (Target Host)

1. Create `/opt/nightlamp/.env` with all secrets:
   ```env
   NODE_ENV=staging
   DATABASE_PATH=/data/nightlamp.db
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   SENTRY_DSN=https://...
   UPTIMEROBOT_API_KEY=u...
   UPTIMEROBOT_MAIN_MONITOR_ID=...
   ```

2. Place `docker-compose.yml` in `/opt/nightlamp/`
3. Run: `docker compose up -d`

## Verification

```bash
curl http://localhost:3000/health
# → {"status":"ok","service":"nightlamp-backend"}

# Playbook API
curl http://localhost:3000/api/playbooks
# → []

# Billing API
curl http://localhost:3000/api/billing/subscription
```

## Backup & Restore

The SQLite database is stored on a Docker volume (`nightlamp_data`).

### Backup

```bash
# Manual backup
docker run --rm -v nightlamp_data:/data -v $(pwd):/backup alpine \
  cp /data/nightlamp.db /backup/nightlamp-$(date +%Y%m%d-%H%M%S).db

# Automated (cron — run on host)
# 0 3 * * * docker run --rm -v nightlamp_data:/data -v /backups:/backup alpine cp /data/nightlamp.db /backup/nightlamp-$(date +\%%Y\%%m\%%d-\%%H\%%M\%%S).db
```

### Restore

```bash
# Stop the service
docker compose down

# Replace the database
docker run --rm -v nightlamp_data:/data -v $(pwd):/backup alpine \
  sh -c "cp /backup/nightlamp-20260101-000000.db /data/nightlamp.db"

# Restart
docker compose up -d
```

## Rollback

### Image rollback
```bash
# Roll back to previous SHA
docker compose down
docker pull ghcr.io/nightlamp/monitoring:sha-<previous-commit>
docker compose up -d

# Or tag a known-good version
docker tag ghcr.io/nightlamp/monitoring:sha-<good> ghcr.io/nightlamp/monitoring:latest
docker compose up -d
```

### Database rollback
Restore a database backup (see Backup & Restore above), then restart.
Note: downgrading the DB schema is not automatic — manual SQL migration may be required.

## Monitoring Setup

### UptimeRobot (external)
1. Create a monitor pointing at `https://staging.example.com/health`
2. Set check interval: 5 minutes
3. Alert contacts: email + Slack
4. Expected response: HTTP 200 + JSON with `status: "ok"`

### Host-level monitoring
```bash
# Disk usage
df -h /data

# Memory
free -m

# Docker container health
docker ps --filter status=restarting

# Logs
docker compose logs --tail=100 -f api
```

### Application health endpoints
| Endpoint | Purpose |
|---|---|
| `GET /health` | Liveness check — returns 200 if server is up |
| `GET /api/playbooks` | Playbook API — returns 200 + array |
| `GET /api/billing/subscription` | Billing API — returns 200 or 4xx |

## Architecture Diagram

```
Internet → Host:3000 → Docker:3000 → Node.js (Express)
                                        ├── /health
                                        ├── /api/playbooks/*
                                        ├── /api/billing/*
                                        └── /api/dependency-health
```
