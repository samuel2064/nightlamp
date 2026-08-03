# On-Call Guide

Owner: Backend Engineer / Ops
Related: [Incident Response](incident-response.md), [Escalation & On-Call](escalation-and-oncall.md)

## Rotation

- 7-day rotations cycling `backend-engineer → cto → ceo`.
- `getOnCallAt(nowIso)` picks the current primary deterministically from `windowStartUtc`.
- Current roster + policy: `GET https://nightlamp-api.onrender.com/api/alerting/escalation`.

## Before Your Shift

1. Confirm you can reach Render dashboard + GitHub Actions.
2. Test `GET /api/health` returns `status: ok`.
3. Review known playbook entries (`GET /api/playbook`) for recurring patterns.
4. Set your notification channels so P1 pages land on your device.

## During the Shift

| P | Response target | Action |
| - | --------------- | ------ |
| P1 | < 5 min | Page, acknowledge, follow `incident-response.md` top scenario. |
| P2 | < 30 min | Triage, verify, decide if it needs a workaround or rollback. |
| P3 | business hours | Log and track; no paging. |

## Communication Channels

- **Ops alerts:** Slack `#alerts` (P3), `#incidents` (P1/P2).
- **Outage comms:** post a status line in `#incidents` at detection, on resolution.
- **Handoff:** note the current on-call, open issues, and follow-ups in the shift handoff doc.

## Shift Handoff Checklist

1. Hand over any running incidents with current state + next steps.
2. Note known flaky tests/deploys.
3. Record any new failure pattern that still needs a runbook entry.