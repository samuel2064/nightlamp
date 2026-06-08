# Component Library

## Overview

Reusable UI component specifications for the Nightlamp design system. All components use CSS custom properties from `design-system.md`. Built for React with Tailwind CSS or plain CSS modules.

---

## Button

### Variants

| Variant | Background | Text | Border | Hover | Usage |
|---------|-----------|------|--------|-------|-------|
| Primary | `--color-primary-500` | White | None | `--color-primary-600` | Main CTAs |
| Secondary | Transparent | `--color-primary-500` | `--color-primary-500` | `--color-primary-50` bg | Secondary actions |
| Ghost | Transparent | `--color-surface-700` | None | `--color-surface-100` bg | Tertiary actions |
| Danger | `--color-error` | White | None | Darker error | Destructive actions |
| Disabled | `--color-surface-200` | `--color-surface-700` (50% opacity) | None | Same as default | No-op state |

### Sizes

| Size | Padding X | Padding Y | Font Size | Icon Size |
|------|-----------|-----------|-----------|-----------|
| sm | `--space-3` | `--space-1` | `--text-sm` | 14px |
| md | `--space-4` | `--space-2` | `--text-sm` | 16px |
| lg | `--space-5` | `--space-3` | `--text-base` | 18px |

### States

- Loading: spinner icon replaces text (same width to prevent layout shift), text hidden
- Icon + text: icon before text with `--space-2` gap
- Icon only: square aspect ratio, tooltip on hover

---

## Badge / Pill

```
[🔴 Critical]  [🟡 Warning]  [🟦 Info]  [✅ Operational]
```

| Prop | Values |
|------|--------|
| Variant | `critical`, `warning`, `info`, `success`, `neutral` |
| Size | `sm` (8px height), `md` (20px height) |
| Dot | Icon dot on left for severity variants |

---

## Status Indicator

```
🟢 Operational    — Full height, green left border
🟡 Degraded       — Full height, yellow left border  
🔴 Down           — Full height, red left border
```

- 4px left border in severity color
- Dot + label
- Used on tables, cards, widget headers

---

## Card

```
┌──────────────────────────────────────────────────────┐
│  [Header content — title + actions if needed]         │
│                                                       │
│  [Body content]                                       │
│                                                       │
│  [Optional footer]                                    │
└──────────────────────────────────────────────────────┘
```

| Token | Value |
|-------|-------|
| Background | `--color-surface-0` |
| Border | `--color-surface-200`, 1px |
| Border radius | `--radius-md` |
| Padding | `--space-5` |
| Shadow | `--shadow-sm`, hover: `--shadow-md` |
| Header | Separator bottom border (optional) |

Sub-variants:
- **Interactive card** — hover lift effect, cursor pointer, clickable
- **Stat card** — Centered large number, label below, optional trend arrow
- **Widget card** — Draggable, resize handle on bottom-right

---

## Table

```
┌──────────────────────────────────────────────────────────┐
│  Header row — bold, `--color-surface-700`, bottom border │
├──────┬──────┬──────┬──────┬──────┬───────────────────────┤
│ Cell │ Cell │ Cell │ Cell │ Cell │ Actions (icon btns)   │
│ Hover│highlight  bg                                         │
│ Striped: nth-child(even)                                    │
└──────┴──────┴──────┴──────┴──────┴───────────────────────┘
```

| Token | Value |
|-------|-------|
| Cell padding | `--space-3` vertical, `--space-4` horizontal |
| Header bg | `--color-surface-50` |
| Row hover | `--color-surface-50` |
| Striped | `--color-surface-50` on even rows (optional, for dense data) |
| Sort indicator | Arrow up/down in header on sortable columns |

---

## Input

```
┌────────────────────────────────────────┐
│  Label                                  │
│  ┌────────────────────────────────┐    │
│  │ [Placeholder text...]          │    │
│  └────────────────────────────────┘    │
│  Hint or error text below              │
└────────────────────────────────────────┘
```

| Token | Value |
|-------|-------|
| Padding | `--space-2` vertical, `--space-3` horizontal |
| Border | 1px `--color-surface-200` |
| Focus ring | 2px `--color-primary-500` with 50% opacity |
| Error | Border `--color-error`, error text below |
| Disabled | `--color-surface-100` bg, 50% text |

Variants:
- **Search input** — magnifying glass icon left, clear button on right when filled
- **Select** — custom chevron icon on right, native `<select>` fallback
- **Textarea** — min 3 rows, resizable vertical

---

## Modal / Dialog

```
┌───── Overlay (50% black, backdrop blur optional) ──────┐
│  ┌─────────────────────────────────────────────────┐    │
│  │  [Title]                              [✕]       │    │
│  ├─────────────────────────────────────────────────┤    │
│  │  Body content                                    │    │
│  │                                                   │    │
│  ├─────────────────────────────────────────────────┤    │
│  │  [Cancel]                              [Confirm]│    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

| Token | Value |
|-------|-------|
| Width | `480px` (default), `640px` (large), `320px` (small) |
| Border radius | `--radius-lg` |
| Padding | `--space-6` |
| Overlay bg | `rgba(0,0,0,0.5)` |
| Animation | Fade in overlay + scale up modal (100ms) |
| Close | Escape key + clicking overlay (if not destructive) |
| Focus trap | Tab cycles within modal |

---

## Toast / Notification

```
┌──────────────────────────────────────────┐
│  ✅ Plan updated successfully     [✕]    │
│  2 seconds ago                            │
└──────────────────────────────────────────┘
```

| Variant | Icon | Background | Border Left |
|---------|------|------------|-------------|
| Success | ✅ | `--color-surface-0` | `--color-success` |
| Error | ❌ | `--color-surface-0` | `--color-error` |
| Warning | ⚠️ | `--color-surface-0` | `--color-warning` |
| Info | ℹ️ | `--color-surface-0` | `--color-info` |

Position: bottom-right, stacked. Auto-dismiss: 5s (success/info), manual dismiss required (error).

---

## Skeleton / Loading State

```
┌──────────────────────────────────────────┐
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  — Title skeleton
│                                          │
│  ▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒  │  — Content skeleton (shimmer)
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒  │
└──────────────────────────────────────────┘
```

- Animated shimmer gradient moving left to right
- Approximates the layout of final content
- Rounded rectangles (`--radius-sm`)
- Used on: dashboard widget loading, table loading, playbook detail loading

---

## Tabs

```
[Monitors] [Playbooks] [Billing] [Settings]
     ───── active tab indicator
```

| Token | Value |
|-------|-------|
| Active | `--color-primary-500` text + underline |
| Inactive | `--color-surface-700` text, hover: `--color-surface-900` |
| Underline | 2px `--color-primary-500` |
| Padding | `--space-3` horizontal, `--space-2` vertical |

---

## Toggle / Switch

```
○ Off                     ● On
```

| State | Track | Knob |
|-------|-------|------|
| Off | `--color-surface-200` | White |
| On | `--color-primary-500` | White |
| Disabled | 50% opacity | |

Width: 36px, height: 20px. Knob: 16px circle. Transition: 150ms.

---

## Progress Bar / Usage Meter

```
Monitors: ████████████████░░░░░░░░░  15 / 25
```

| Token | Value |
|-------|-------|
| Height | 8px |
| Border radius | `--radius-full` |
| Track bg | `--color-surface-200` |
| Fill bg | `--color-primary-500` (default), `--color-warning` (75%+), `--color-error` (90%+) |
| Animation | Smooth width transition 300ms |

---

## Dropdown Menu

```
┌──────────────────────────┐
│  Edit Monitor          │
│  Run Check Now         │
│  ───────────────────  │
│  Disable Monitor       │
│  🟥 Delete            │
└──────────────────────────┘
```

| Token | Value |
|-------|-------|
| Width | `200px` min |
| Item padding | `--space-2` vertical, `--space-4` horizontal |
| Item hover | `--color-surface-50` |
| Divider | 1px `--color-surface-200` |
| Danger item | Red text on hover |
| Shadow | `--shadow-lg` |
| Trigger | Click (not hover) |

---

## Empty State

```
                    ┌──────┐
                    │ icon │
                    └──────┘

                    Title text
                    Description text (optional)

                    [Call to action button]
```

- Centered in container
- Subtle icon (48x48) in `--color-surface-200`
- Title: `--text-lg`, `--color-surface-900`
- Description: `--text-sm`, `--color-surface-700`
- CTA button below

---

## Tooltip

```
   ┌─────────────┐
   │ Tooltip text │
   └─────────────┘
         ▲
         │
      [Element]
```

| Token | Value |
|-------|-------|
| Background | `--color-surface-900` |
| Text | White |
| Font size | `--text-xs` |
| Padding | `--space-1` vertical, `--space-2` horizontal |
| Radius | `--radius-sm` |
| Show delay | 500ms |
| Hide delay | 100ms |