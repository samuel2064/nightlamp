# Nightlamp Design System

## Brand Colors

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-primary-50` | `#eef2ff` | Background tint |
| `--color-primary-100` | `#e0e7ff` | Hover background |
| `--color-primary-500` | `#6366f1` | Primary buttons, links, active states |
| `--color-primary-600` | `#4f46e5` | Primary hover |
| `--color-primary-700` | `#4338ca` | Primary active |

| Token | Hex | Usage |
|-------|-----|-------|
| `--color-surface-0` | `#ffffff` | Cards, modal backgrounds |
| `--color-surface-50` | `#f8fafc` | Page background |
| `--color-surface-100` | `#f1f5f9` | Sidebar, secondary surfaces |
| `--color-surface-200` | `#e2e8f0` | Borders, dividers |
| `--color-surface-700` | `#334155` | Secondary text |
| `--color-surface-900` | `#0f172a` | Primary text, headings |

## Semantic Colors

| Token | Hex | Icon | Usage |
|-------|-----|------|-------|
| `--color-success` | `#22c55e` | ✅ | Healthy checks, uptime OK |
| `--color-warning` | `#f59e0b` | ⚠️ | Warning severity, rate limits |
| `--color-error` | `#ef4444` | 🔴 | Critical failures, down checks |
| `--color-info` | `#3b82f6` | ℹ️ | Info severity, new patterns |

## Severity Badge Mapping

| Severity | Color Token | Background | Dot |
|----------|-------------|------------|-----|
| `critical` | `--color-error` | `#fef2f2` / `#dc2626` filled | 🟥 |
| `warning` | `--color-warning` | `#fffbeb` / `#d97706` filled | 🟨 |
| `info` | `--color-info` | `#eff6ff` / `#2563eb` filled | 🟦 |

## Typography

| Token | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| `--text-xs` | 0.75rem (12px) | 400 | 1.5 | Labels, timestamps |
| `--text-sm` | 0.875rem (14px) | 400/500 | 1.5 | Body, table cells |
| `--text-base` | 1rem (16px) | 400/500 | 1.5 | Default body text |
| `--text-lg` | 1.125rem (18px) | 600 | 1.4 | Section headings |
| `--text-xl` | 1.25rem (20px) | 600 | 1.3 | Card titles |
| `--text-2xl` | 1.5rem (24px) | 700 | 1.25 | Page titles |
| `--text-3xl` | 1.875rem (30px) | 700 | 1.2 | Dashboard hero numbers |
| `--text-mono` | 0.875rem | 400 | 1.7 | Log output, code blocks |

**Font family:** `Inter` (UI), `JetBrains Mono` (code/logs).

## Spacing (4px grid)

| Token | Pixels | Rem | Usage |
|-------|--------|-----|-------|
| `--space-1` | 4px | 0.25rem | Micro spacing |
| `--space-2` | 8px | 0.5rem | Tight padding |
| `--space-3` | 12px | 0.75rem | Compact padding |
| `--space-4` | 16px | 1rem | Default padding |
| `--space-5` | 20px | 1.25rem | Card padding |
| `--space-6` | 24px | 1.5rem | Section gap |
| `--space-8` | 32px | 2rem | Large gaps |
| `--space-10` | 40px | 2.5rem | Page margins |
| `--space-12` | 48px | 3rem | Hero spacing |

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 4px | Inputs, badges |
| `--radius-md` | 8px | Cards, buttons |
| `--radius-lg` | 12px | Modals, panels |
| `--radius-xl` | 16px | Hero elements |
| `--radius-full` | 9999px | Pills, avatars |

## Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,0.05)` | Subtle card border |
| `--shadow-md` | `0 4px 6px -1px rgba(0,0,0,0.1)` | Cards, dropdowns |
| `--shadow-lg` | `0 10px 15px -3px rgba(0,0,0,0.1)` | Modals, elevated panels |
| `--shadow-xl` | `0 20px 25px -5px rgba(0,0,0,0.15)` | Toasts, dialogs |

## Iconography

Use **Lucide React** (`lucide-react`) for all UI icons. Key icons by context:

| Context | Icon |
|---------|------|
| Dashboard | `LayoutDashboard` |
| Monitors | `Activity` |
| Playbooks | `BookOpen` |
| Billing | `CreditCard` |
| Settings | `Settings` |
| Notifications | `Bell` |
| Status healthy | `CheckCircle` |
| Status warning | `AlertTriangle` |
| Status error | `XCircle` |
| Status info | `Info` |

## Layout (Dashboard)

```
┌──────────────────────────────────────────────────┐
│  Top Bar: Logo | Search | Notifications | User   │
├──────────┬───────────────────────────────────────┤
│          │                                       │
│ Sidebar  │  Main Content Area                    │
│          │                                       │
│ Dashboard│  (Widget grid, tables, detail views)  │
│ Monitors │                                       │
│ Playbooks│                                       │
│ Billing  │                                       │
│ Settings │                                       │
│          │                                       │
├──────────┴───────────────────────────────────────┤
│  Footer: Status bar, last poll timestamp          │
└──────────────────────────────────────────────────┘
```

**Sidebar width:** 240px collapsed, 64px icons-only.
**Max content width:** 1280px centered.
**Breakpoints:** 640px / 768px / 1024px / 1280px.