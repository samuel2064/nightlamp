# Dashboard & Monitoring UI

> **Backend alignment:** Dashboard data maps to these API endpoints:
> - Aggregate stats: `GET /api/health` → `{ stats: { checks, failureEvents, playbookEntries } }`
> - Events feed: `GET /api/events` → `{ events: [{ id, checkId, failureType, severity, title, description, detectedAt, acknowledged }] }`
> - Check results: `GET /api/check-results` → `{ results: [{ id, checkId, status, summary, executedAt }] }`
> - Playbook match: `GET /api/playbook/match?q=...`
>
> Note: SSL Expiry widget has no backend data source yet — it is aspirational UI for Phase 2.

## Overview

The dashboard is the default landing page. It gives an at-a-glance health summary and surfaces active issues. The Monitors section provides per-check detail and historical data.

---

## Dashboard Page

### 1. Status Hero Section

```
┌─────────────────────────────────────────────────────────────┐
│  [🟢]  All Systems Operational        Last checked: 12s ago │
│                                                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │    24       │  │     3       │  │     1       │          │
│  │  Monitors   │  │  Failures   │  │  Critical   │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

- Large status pill: `🟢 Operational` / `🟡 Degraded` / `🔴 Down`
- Last polled timestamp (relative + absolute on hover)
- 3 stat cards: total monitors, active failures, critical count

### 2. Widget Grid

Draggable, resizable grid of dashboards widgets:

```
┌──────────────────────┬──────────────────────┬──────────────────┐
│ Active Failures      │ Uptime (24h)         │ Error Rate       │
│ 🔴 1 critical        │ ▁▂▃▄▅▆▇██▇▆▅▄▃▂▁     │ ▁▂▃▄▅▆▇██▇▆▅▄▃▂▁ │
│ 🟡 2 warnings        │ 99.7% uptime        │ 12 errors/min     │
│                      │                      │                   │
├──────────────────────┼──────────────────────┼──────────────────┤
│ Recent Failures      │ SSL Expiry           │ Rate Limits       │
│ • expired_token  12s │ api.nightlamp.dev    │ Sentry: 2 shifts  │
│ • rate_limit    2m   │ expires in 27d       │ Stripe: 1 shift   │
│ • schema_drift  5m   │ 🟢 Okay              │ 🟡 Monitor        │
│ [View all →]         │                      │                   │
└──────────────────────┴──────────────────────┴──────────────────┘
```

Widget types:
- **ActiveFailuresWidget** — List of recent failure events with severity dots, type, timestamp. Data source: `GET /api/events?limit=10`
- **UptimeSparklineWidget** — 24h uptime sparkline (SVG), percentage, current status. Data source: aggregated from `GET /api/check-results` by computing pass/fail ratio per time bucket
- **ErrorRateWidget** — Sentry error rate sparkline, current RPM. Data source: `GET /api/check-results` with Sentry-sourced check statuses
- **RecentFailuresWidget** — Compact list of last 5 failures, clickable to playbook. Data source: `GET /api/events?limit=5`
- **SSLExpiryWidget** — *(Phase 2 aspirational)* Countdown to SSL cert expiry for each monitored domain. No backend data source yet.
- **RateLimitWidget** — Detected rate limit shifts, grouped by provider. Data source: `GET /api/events?type=rate_limit_shift`
- **PlaybookMatchWidget** — *(bonus widget)* Quick-playbook lookup: enter symptom text, get matched playbook via `GET /api/playbook/match`

### 3. Empty State

```
┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                    [🎉] All Clear!                            │
│              No failures detected in the last 24h.            │
│                                                              │
│              [Add Your First Monitor]                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Monitors Page

### 1. Monitors List Table

```
┌────────────────────────────────────────────────────────────────┐
│ Monitors                    [+ Add Monitor]  [🔍 Search...]   │
├──────┬──────────┬──────────┬──────────┬──────────┬────────────┤
│ Name │ Source   │ Status   │ Last Run │ Failures │ Actions    │
├──────┼──────────┼──────────┼──────────┼──────────┼────────────┤
│ API  │ Sentry   │ 🟢 OK    │ 30s ago  │ 0        │ [View] [⋮] │
│ Web  │ Uptime   │ 🟡 Warn  │ 12s ago  │ 3        │ [View] [⋮] │
│ Auth │ Sentry   │ 🔴 Crit  │ 45s ago  │ 1        │ [View] [⋮] │
└──────┴──────────┴──────────┴──────────┴──────────┴────────────┘
```

Columns: Name, Source (Sentry/UptimeRobot badge), Status pill, Last Run (relative), Failures (count), Actions (view detail + overflow menu).

### 2. Monitor Detail View

```
┌──────────────────────────────────────────────────────────────┐
│  ← Monitors  /  Auth Service                                  │
│                                                               │
│  Status: 🔴 Critical    Source: Sentry    ID: sentry-auth-1   │
│                                                               │
│  ┌───────────────────────────────────────────────────────┐    │
│  │ Timeline: [1h] [6h] [24h] [7d] [30d]                  │    │
│  │                                                        │    │
│  │   🟢 ████████🟢████████🟢████████🔴█🔴██🟡███          │    │
│  │   12:00    14:00    16:00    18:00    20:00            │    │
│  └───────────────────────────────────────────────────────┘    │
│                                                               │
│  Failure History                                               │
│  ┌──────┬──────────┬───────────┬────────────────┬──────────┐  │
│  │ Time │ Type     │ Severity  │ Description    │ Playbook │  │
│  ├──────┼──────────┼───────────┼────────────────┼──────────┤  │
│  │ 12s  │exp_token │ 🔴 Crit   │ 401 auth fail  │ [Open]   │  │
│  │ 2m   │rate_lim  │ 🟡 Warn   │ 429 rate limit │ [Open]   │  │
│  └──────┴──────────┴───────────┴────────────────┴──────────┘  │
│                                                               │
│  [Acknowledge All]  [Run Check Now]  [Edit Monitor]           │
└──────────────────────────────────────────────────────────────┘
```

Key features:
- Time range selector for timeline
- Color-coded timeline bar (green=ok, yellow=warning, red=error)
- Failure history table with direct playbook links
- Action buttons: acknowledge, run check, edit monitor config

---

## Key Interactions

1. **Widget grid** — Drag to reorder, resize handles on widget corners.
2. **Status pill** — Click to expand a detailed breakdown by source.
3. **Failure row click** — Navigates to playbook detail for that failure type.
4. **Acknowledge** — Marks failure as acknowledged (dims it, moves to "acknowledged" section).
5. **Timeline brushing** — Click-drag to zoom into a time range on any timeline.