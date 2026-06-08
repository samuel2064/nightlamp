# Nightlamp Product Design

Welcome to the Nightlamp design system and UX documentation. This is the single source of truth for the product's look, feel, and interaction patterns.

## Contents

| File | Description |
|------|-------------|
| [Design System](design-system.md) | Colors, typography, spacing, shadows, layout grid |
| [Dashboard & Monitoring UI](dashboard.md) | Dashboard hero, widget grid, monitors list, detail view |
| [Playbook Reader](playbook-reader.md) | Playbook list, detail page, markdown rendering, checklist interaction |
| [Subscription & Billing](subscription-billing.md) | Plan management, comparison table, payment methods, cancellation flow |
| [Component Library](components/component-library.md) | Buttons, badges, tables, inputs, modals, toasts, empty states |

## Interactive Mockups

Open HTML files in browser for clickable prototypes:

| Mockup | File |
|--------|------|
| Dashboard | [mockups/dashboard-mockup.html](mockups/dashboard-mockup.html) |
| Playbook List | [mockups/playbook-list-mockup.html](mockups/playbook-list-mockup.html) |
| Playbook Detail | [mockups/playbook-detail-mockup.html](mockups/playbook-detail-mockup.html) |
| Billing Portal | [mockups/billing-mockup.html](mockups/billing-mockup.html) |

## Design Principles

1. **Calm monitoring** — The UI should feel reassuring, not alarming. Use color intentionally. Bad news gets prominent placement but never panic-inducing styling.
2. **Progressive disclosure** — Show the big picture first, let users drill into details. Dashboard shows aggregate status; click into specific monitors for raw data.
3. **Action-oriented** — Every failure event should have a clear next step. Playbooks are the primary action surface — always a click away from any failure.
4. **Consistent language** — Failure types, severities, and status labels match the backend exactly. `expired_token` in the DB is "Expired Token" in the UI.
5. **Dark pattern avoidance** — Never trick users. Plan changes show proration and feature impact. Cancellation collects feedback and confirms intent.

## Tech Stack Recommendations

- **Framework**: React + TypeScript (matches existing backend language)
- **Styling**: Tailwind CSS with CSS custom properties for design tokens
- **Icons**: Lucide React
- **Charts**: Recharts (sparklines, timelines) or lightweight SVG
- **Drag/resize**: react-grid-layout (dashboard widgets)
- **Markdown rendering**: react-markdown with custom components for checklist/code blocks