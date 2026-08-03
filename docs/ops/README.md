# Nightlamp Operations Runbooks

Production services and operational playbooks are documented here.

## Services

| Service | URL |
| ------- | --- |
| Backend API | https://nightlamp-api.onrender.com |
| Frontend | https://nightlamp-frontend.onrender.com |
| Health (self-monitoring) | `GET /api/health` |
| Latency (p95/p99) | `GET /api/performance/latency` |
| Escalation policy | `GET /api/alerting/escalation` |
| Render dashboard | https://dashboard.render.com |
| GitHub repo | https://github.com/samuel2064/nightlamp |

## Runbooks

| Document | When to use |
|----------|-------------|
| [Incident Response](incident-response.md) | Top-10 failure scenarios + resolution steps. |
| [Deployment & Rollback](deployment-and-rollback.md) | Standard/emergency deploy, rollback, staging, secrets. |
| [Escalation & On-Call](escalation-and-oncall.md) | P1/P2/P3 escalation chains + roster. |
| [On-Call Guide](on-call-guide.md) | Rotation, communications, shift handoff. |
| [Dependency Upgrades](dependency-upgrades.md) | Standard/emergency dependency change procedure. |

## Alerting & SLO

- Alert rules fire on: error rate > 1%, p95 latency > 500ms, downtime > 1 min.
- SLO/SLI definitions & baselines: [SLO docs](../slo/README.md).
- Severity → priority: [`src/alerting/escalation.ts`](../../src/alerting/escalation.ts).

## Escalation Contacts

| Priority | Primary | Secondary |
| --- | --- | --- |
| P1 | on-call (Backend Eng) | CTO |
| P2 | on-call | CTO |
| P3 | triage channel | — |

## SLA Target

- Rollback in < 5 minutes.
- Standard deployment requires zero manual steps (push to main → pipeline).