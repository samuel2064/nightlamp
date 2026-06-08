# Diagnostic Playbook Reader

> **Backend alignment:** Playbook data maps to these API endpoints:
> - List: `GET /api/playbook` → `{ entries: [{ id, failureType, title, firstSeenAt, lastOccurrenceAt, occurrenceCount }] }`
> - Search: `GET /api/playbook/search?q=...`
> - Match by symptoms: `GET /api/playbook/match?symptoms=...` → returns `{ matches: [{ id, failureType, title, snippet, severity, confidence }] }`
> - Correlations: `GET /api/playbook/correlations?failureType=...` → co-occurring failure types
> - Remediation: `POST /api/playbook/remediate` → triggers auto-remediation script
> - Logs: `GET /api/playbook/remediation-logs`
>
> Playbook body markdown is generated server-side from templates in `src/playbook/writer.ts`. All 7 failure types have built-in templates.

## Overview

The Playbook Reader renders auto-generated diagnostic playbooks (markdown) into an interactive, guided remediation experience. Playbooks are generated server-side from detected failure types and stored as structured markdown with symptom/diagnostic/resolution sections.

---

## Playbook List Page

```
┌──────────────────────────────────────────────────────────────┐
│ Playbooks                           [🔍 Search playbooks...] │
│                                                                │
│ ┌──────────────┬──────────────────────────────────────────────┤
│ │ Filters      │  Cards                                       │
│ │              │                                              │
│ │ All Types    │  ┌────────────────────────────────────────┐  │
│ │ 🔴 Critical  │  │ Expired Token Investigation            │  │
│ │ 🟡 Warning   │  │ 🔴 Critical · Seen 3 times             │  │
│ │ ℹ️ Info      │  │ First: May 18 · Last: 12s ago          │  │
│ │              │  │ [Open Playbook]                         │  │
│ │ By Source:   │  └────────────────────────────────────────┘  │
│ │ ☑ Sentry     │                                              │
│ │ ☑ UptimeRobot│  ┌────────────────────────────────────────┐  │
│ │              │  │ Rate Limit Shift Investigation          │  │
│ │ Severity:    │  │ 🟡 Warning · Seen 1 time                │  │
│ │ [Critical]   │  │ First: May 18 · Last: 2m ago            │  │
│ │              │  │ [Open Playbook]                         │  │
│ └──────────────┘  └────────────────────────────────────────┘  │
│                                              ┌──────────────┐ │
│                                              │ Schema Drift  │ │
│                                              │ ⚠️ Warning     │ │
│                                              │ ...           │ │
│                                              └──────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Playbook Card Spec

| Element | Style |
|---------|-------|
| Title | `--text-lg`, semibold, `--color-surface-900` |
| Severity badge | Pill with severity color, `--radius-full` |
| Occurrence count | `--text-sm`, secondary text |
| First/last seen | `--text-xs`, `--color-surface-700` |
| Card | White bg, `--radius-md`, `--shadow-sm`, hover: `--shadow-md` with `--color-primary-500` left border |
| CTA | "Open Playbook" text button, `--color-primary-500` |

### Search/Filter

- **Search**: immediate full-text match on title + body (plays well with server-side SQL LIKE query on `playbook_entries.body`)
- **Filter pane**: severity toggle group + failure type checkboxes
- Empty search: "No playbooks match your search" illustration + suggestion

---

## Playbook Detail Page

```
┌──────────────────────────────────────────────────────────────┐
│ ← Playbooks  /  Expired Token Investigation                  │
│                                                               │
│ 🔴 Critical    ·   First seen: May 18, 2026                  │
│                ·   Last occurrence: 12 seconds ago            │
│                ·   Occurrence count: 3                        │
│                                                               │
│ ┌──────────────────────────────────────────────────────────┐  │
│ │ [▶ Run Diagnostic]  [Acknowledge]  [⋮ More]             │  │
│ └──────────────────────────────────────────────────────────┘  │
│                                                               │
│ ┌───────────────────────────────┬────────────────────────────┐ │
│ │  ## Symptoms                  │  Related Playbooks         │ │
│ │                               │                            │ │
│ │  ☐ 401/403 responses         │  • Rate Limit Shift        │ │
│ │     from API calls           │    🟡 Warning · 2m ago     │ │
│ │                               │                            │ │
│ │  ☐ Error messages            │  • Broken Webhook          │ │
│ │    mentioning "expired",     │    🔴 Critical · 5m ago    │ │
│ │    "invalid token"           │                            │ │
│ │                               │                            │ │
│ │  ## Diagnostic Steps          │  [View All Playbooks →]   │ │
│ │                               │                            │ │
│ │  ☐ 1. Check token expiry     │  ───────────────────────── │ │
│ │       in provider dashboard  │  Quick Actions             │ │
│ │                               │                            │ │
│ │  ☐ 2. Verify token in env    │  [View in Dashboard]      │ │
│ │                               │                            │ │
│ │  ☐ 3. Test token with curl   │  [Create Ticket]          │ │
│ │                               │                            │ │
│ │  ☐ 4. Check if revoked       │  [Copy Share Link]        │ │
│ │                               │                            │ │
│ │  ## Resolution                │                            │ │
│ │                               │                            │ │
│ │  ▶ Generate new token...     │                            │ │
│ │  ▶ Update env variable...    │                            │ │
│ │  ▶ Implement refresh...      │                            │ │
│ └───────────────────────────────┴────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### Markdown Rendering Rules

Playbook `.body` content follows this structure (parsed from `src/playbook/writer.ts` templates):

```markdown
## <FailureType Name>

### Symptoms
- Bullet list of symptoms

### Diagnostic Steps
1. Numbered step
2. Numbered step

### Resolution
- Action item
- Action item
```

**Rendering behavior:**

| Markdown | UI Treatment |
|----------|-------------|
| `## Title` | Section header with bottom border |
| `### Symptoms/Diagnostic/Resolution` | Collapsible section (default: open for Symptoms + Diagnostics, closed for Resolution) |
| `- Bullet` | Checkbox item (`☐` → toggleable `☑`) |
| `1. Numbered` | Checkbox with step number |
| `` `inline code` `` | Mono font, `--color-surface-100` background |
| `curl ...` | Copy-to-clipboard button on hover |

### Checklist Behavior

- Each `☐` item toggles to `☑` independently
- Toggle state is persisted per-user per-playbook in local state
- When all items in a section are checked, the section header gets a subtle green checkmark indicator
- No server sync for check state (keeps it lightweight)

### "Run Diagnostic" CTA

- Opens a modal/slideover that walks through the diagnostic steps sequentially
- Each step has a "Done" button that advances
- Final step provides a "Mark as Resolved" action that:
  - Acknowledges related failure events in the system
  - Navigates back to the playbook list

---

## Integration Points with Backend

| Backend Data | UI Surface |
|-------------|-----------|
| `PlaybookEntry.failureType` | Severity badge color + icon mapping |
| `PlaybookEntry.title` | Card title / detail page H1 |
| `PlaybookEntry.body` | Rendered markdown with interactive sections |
| `PlaybookEntry.firstSeenAt` | "First seen" metadata |
| `PlaybookEntry.lastOccurrenceAt` | Relative timestamp "X ago" |
| `PlaybookEntry.occurrenceCount` | Badge on list card |
| `FailureEvent.severity` | Severity badge on card + detail header |
| `FailureEvent.acknowledged` | "Acknowledge" button state |

## Empty State

```
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│                    [📖] No Playbooks Yet                      │
│        Playbooks are generated when failures are detected.    │
│        They'll appear here automatically.                     │
│                                                               │
│              [Go to Dashboard →]                              │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```