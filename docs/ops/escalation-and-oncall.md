# Alert Escalation Policy & On-Call

Owner: Backend Engineer / Ops
Related: [Deployment & Rollback](deployment-and-rollback.md), [SLO documentation](../slo/README.md)

Nightlamp classifies every alert into a priority (P1/P2/P3) derived from its
severity, then escalates through a fixed chain of channels until acknowledged.

## Severity → Priority

| Severity  | Priority | Meaning                                                        |
| --------- | -------- | ------------------------------------------------------------- |
| critical  | P1       | Outage, data loss, security incident, sustained SLO breach.   |
| warning   | P2       | Degraded service, elevated error rate / latency for a subset. |
| info      | P3       | Low-impact anomaly, routine degradation.                      |

Implementation: `SEVERITY_TO_PRIORITY` in `src/alerting/escalation.ts`.

## Alert Rules (fire thresholds)

Configured via alert rules (`/api/alerting/rules`). Recommended production rules:

| Priority | Rule | Condition |
| -------- | ---- | --------- |
| P1 | Error rate breach | error rate > 1% over 10 min window |
| P1 | Downtime | service down > 1 minute |
| P2 | Latency breach | p95 latency > 500ms over 10 min window |
| P2 | SLO breach | any Phase-3 SLO target exceeded |
| P3 | Anomaly | low-impact new error pattern |

## Escalation Chains

- **P1** → page on-call via PagerDuty (immediate) → `#incidents` (Slack) → email (5 min) → reassign based on acknowledgement (10 min ack timeout).
- **P2** → `#incidents` (immediate) → escalate to P1 on-call if unacknowledged (30 min ack, 10 min escalate).
- **P3** → `#alerts` (Slack) + in-app dashboard. No paging.

```ts
ESCALATION_POLICIES // src/alerting/escalation.ts
```

## On-Call Rotation

Static placeholder roster is defined in `DEFAULT_ON_CALL_ROTATION`. Rotation is
7 days and cycles `backend-engineer → cto → ceo` deterministically from the
`windowStartUtc`.

Production integration: replace the placeholder with a persisted roster or a
PagerDuty schedule API call. The consumer uses `getOnCallAt(nowIso)` which takes
an ISO timestamp and returns the current primary — no other code changes needed.

## Usage

Inspect the live policy and current on-call:

```bash
curl "https://nightlamp-api.onrender.com/api/alerting/escalation?severity=critical"
```

Returns priority, description, escalation steps, acknowledgement timeout, and the
on-call engineer for the current time.

## Testing

Run the escalation policy suite:

```bash
npx mocha --require ts-node/register "src/test/escalation.test.ts"
```