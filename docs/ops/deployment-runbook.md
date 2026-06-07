# Nightlamp Deployment Runbook

## Architecture Overview

Single Node.js (Express) TypeScript service running on port 3000. Data stored in SQLite via a Docker volume. Redis container for optional caching. CI/CD via GitHub Actions building and publishing Docker images to GHCR.

## Prerequisites

- Docker & Docker Compose v2 on the target Linux VM
- GitHub Container Registry (or Docker Hub) access for image pulls
- API keys for Stripe, Sentry, and UptimeRobot (see `.env.example`)
- SSH access to the target host (for remote deploy)

## First-Time Deployment

### 1. Bootstrap the Server

```bash
# Copy and run the setup script
scp scripts/setup-server.sh user@host:/tmp/
ssh user@host bash /tmp/setup-server.sh
```

Or manually:

```bash
# Install Docker (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture)] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
```

### 2. Create Directories and Config

```bash
sudo mkdir -p /opt/nightlamp/data
sudo chown -R 1000:1000 /opt/nightlamp
```

### 3. Configure Environment

Copy `.env.staging` or `.env.production` to `/opt/nightlamp/.env` and fill in real values:

```bash
cp .env.staging /opt/nightlamp/.env
# Edit /opt/nightlamp/.env with your real API keys
```

Required secrets:
- `STRIPE_SECRET_KEY` — Stripe API key
- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret
- `SENTRY_DSN` — Sentry project DSN (optional, leave blank to disable)
- `UPTIMEROBOT_API_KEY` — UptimeRobot API key (optional)
- `UPTIMEROBOT_MAIN_MONITOR_ID` — Monitor ID (optional)

### 4. Start the Stack

```bash
cd /opt/nightlamp
docker compose up -d
```

### 5. Verify

```bash
curl http://localhost:3000/api/healthz
# Expected: {"status":"ok","service":"nightlamp-backend"}

curl http://localhost:3000/health
# Expected: {"status":"ok","service":"nightlamp-backend"}
```

## Updating

### Via Deploy Script

```bash
export TARGET_HOST=user@staging.example.com
./scripts/deploy.sh
```

### Manual Update

```bash
# On the target host:
cd /opt/nightlamp
docker compose pull
docker compose up -d

# Verify
curl http://localhost:3000/api/healthz
```

## Rollback

### Via Rollback Script

```bash
./scripts/rollback.sh sha-previous-commit-hash user@staging.example.com
```

### Manual Rollback

```bash
# On the target host:
ssh user@host

# Pull the previous image
docker pull ghcr.io/nightlamp/monitoring:sha-previous-commit

# Restart with it
cd /opt/nightlamp
IMAGE_TAG=sha-previous-commit docker compose up -d

# Verify
curl http://localhost:3000/api/healthz
```

### Database Rollback

Restore a previous SQLite backup (see Backup section below), then restart the container.

## Monitoring

### Health Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/healthz` | Container HEALTHCHECK — returns 200 if alive |
| `GET /health` | Liveness check — returns 200 + service name |
| `GET /api/playbooks` | Playbook API — returns 200 + array |
| `GET /api/billing/subscription` | Billing API — returns 200 or 4xx |

### Docker Health

```bash
# Check container status
docker ps --filter name=nightlamp

# View logs
docker compose logs --tail=50 -f nightlamp

# Check restarting containers
docker ps --filter status=restarting
```

### Host Monitoring

```bash
# Disk usage
df -h /opt/nightlamp

# Memory
free -m

# Docker disk usage
docker system df
```

## Backup and Restore

### Manual Backup

```bash
docker run --rm -v nightlamp_data:/data -v $(pwd):/backup alpine \
  cp /data/nightlamp.db /backup/nightlamp-$(date +%Y%m%d-%H%M%S).db
```

### Automated Backup (Cron)

```
# Add to crontab (runs daily at 3 AM)
0 3 * * * docker run --rm -v nightlamp_data:/data -v /backups:/backup alpine cp /data/nightlamp.db /backup/nightlamp-$(date +\%Y\%m\%d-\%H\%M\%S).db
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

## Troubleshooting

### Container Won't Start

```bash
# Check container logs
docker compose logs --tail=50 nightlamp

# Common causes:
# - Port 3000 already in use → check with: sudo lsof -i :3000
# - Database permission issue → check volume permissions
# - Missing .env → ensure /opt/nightlamp/.env exists
```

### Health Check Failing

```bash
# Container is running but health check fails
docker inspect --format='{{json .State.Health}}' nightlamp-nightlamp-1

# Check if the app is responding
docker exec nightlamp-nightlamp-1 wget -qO- http://localhost:3000/api/healthz

# If wget isn't available inside the container:
docker exec nightlamp-nightlamp-1 node -e "http.get('http://localhost:3000/api/healthz', r => { let d=''; r.on('data', c => d+=c); r.on('end', () => console.log(d)) })"
```

### Port Already in Use

```bash
# Find what's using port 3000
sudo lsof -i :3000
# or
sudo ss -tlnp | grep 3000

# Stop the conflicting process or change the port mapping in docker-compose.yml
```

### Permission Denied on Volumes

```bash
# Fix data directory permissions
sudo chown -R 1000:1000 /opt/nightlamp/data

# If the container runs as a non-root user (appuser), ensure the volume is writable
sudo chmod 755 /opt/nightlamp/data
```

### Docker Compose Not Found

```bash
# Ensure docker-compose-plugin is installed
docker compose version

# If missing:
sudo apt-get install -y docker-compose-plugin
```

### Out of Disk Space

```bash
# Clean up old images
docker image prune -a -f

# Clean up all unused Docker resources
docker system prune -a -f --volumes
```
