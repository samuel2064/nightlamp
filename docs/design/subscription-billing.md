# Subscription Management & Billing Portal

> **Backend alignment:** This design has been reconciled with the actual backend pricing model in `src/billing/subscription.ts`. Plans match the `PLAN_TIERS` record exactly.

## Overview

Self-serve billing portal: plan overview, plan change, payment method management, invoice history, and cancellation flow. This is a secondary setting area accessible via sidebar → Billing. The backend uses Stripe via `src/billing/stripe-client.ts` for payment processing, and enforces tier limits via `src/billing/tier-enforcer.ts`.

### Pricing Tiers (from Backend)

| Tier | Price | Monitors | Reports/mo | Storage |
|------|-------|----------|------------|---------|
| Basic Support | $99/mo | 5 | 100 | 100 MB |
| Advanced Support | $299/mo | 20 | 500 | 500 MB |
| White-Glove | $499/mo | 100 | 2000 | 2000 MB |

---

## Billing Page

### 1. Current Plan Card

```
┌──────────────────────────────────────────────────────────────┐
│ Current Plan                                                  │
│                                                               │
│ ┌─────────────────────────────────────────────────────────┐   │
│ │  🛡️ Advanced Support                      $299/mo      │   │
│ │                                                          │   │
│ │  Usage this month:                                       │   │
│ │  ████████████████░░░░░░░░░  15 / 20 monitors            │   │
│ │  ████████████░░░░░░░░░░░░░  200 / 500 reports          │   │
│ │  ████████████████░░░░░░░░░  60% storage (300/500 MB)   │   │
│ │                                                          │   │
│ │  [Change Plan →]  [Manage Billing Details ▼]            │   │
│ │ └─────────────────────────────────────────────────────────┘   │
│ └──────────────────────────────────────────────────────────────┘
```

- Plan name, price, billing interval
- Usage meters: monitors used, reports used, storage used
- Usage data served by: `GET /api/billing/usage?customerId=...`
- CTA: "Change Plan" opens comparison table

### 2. Plan Comparison Table

```
┌──────────────────────────────────────────────────────────────┐
│ Compare Plans                                                │
│                                                               │
│              Basic       Advanced    White-Glove              │
│              $99/mo      $299/mo     $499/mo                  │
│              [Current]               [★ Popular]              │
│                                                               │
│ Monitors      5           20          100                     │
│ Reports/mo    100         500         2000                    │
│ Storage       100 MB      500 MB      2000 MB                 │
│ Slack Alerts  ✗           ✓           ✓                       │
│ API Access    ✓           ✓           ✓                       │
│ Team Members  1           5           Unlimited               │
│ SSO           ✗           ✗           ✓                       │
│ Audit Logs    ✗           ✓           ✓                       │
│                                                               │
│               [Current]   [Upgrade]   [Upgrade]               │
│               [Downgrade] [Subscribe] [Contact]               │
└──────────────────────────────────────────────────────────────┘
```

- Current plan highlighted with "Current" badge
- Featured/recommended plan with "Popular" badge
- Check/Cross icons for feature inclusion
- CTA row adapts: "Current" (disabled) for active plan, "Upgrade"/"Downgrade" for adjacent plans, "Subscribe" for new signups, "Contact" for White-Glove
- Plans data served by: `GET /api/billing/plans`

### 3. Plan Change Confirmation

```
┌──────────────────────────────────────────────────────────────┐
│  Confirm Plan Change                                          │
│                                                               │
│  Current:      Advanced Support ($299/mo)                    │
│  New:          Basic Support ($99/mo)                        │
│                                                               │
│  Prorated credit: $149.50                                    │
│  Next bill date: June 18, 2026                               │
│                                                               │
│  ⚠️ You'll lose access to:                                   │
│  • More than 5 monitors (you have 15 — 10 will be paused)   │
│  • Audit logs                                                │
│  • 500-report monthly limit drops to 100                      │
│                                                               │
│  [Cancel]  [Confirm Downgrade]                               │
└──────────────────────────────────────────────────────────────┘
```

- Shows proration summary
- **Critical UX rule:** Warn about feature/service impact before confirming

---

## Payment Method Section

```
┌──────────────────────────────────────────────────────────────┐
│ Payment Method                                                 │
│                                                               │
│ ┌────────────────────────────────────────────────────────┐    │
│ │  💳 Visa ···· 4242  Exp: 12/28                       │    │
│ │  [Update]  [Replace]  [Remove]                       │    │
│ └────────────────────────────────────────────────────────┘    │
│                                                               │
│ ┌─ Add Payment Method ─────────────────────────────────────┐   │
│ │  Card Number    | [____________________________]        │   │
│ │  Expiry         | [______]  CVC  | [______]            │   │
│ │  Cardholder     | [____________________________]        │   │
│ │  [Cancel]  [Add Card]                                   │   │
│ └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

- Saved method display with masked card number + expiry
- Inline add/replace form (no separate page)
- Error state: "Card declined" with reason

---

## Billing History Section

```
┌──────────────────────────────────────────────────────────────┐
│ Billing History                                                │
│                                                               │
│ ┌──────┬──────────┬──────────┬───────────┬────────────────┐   │
│ │ Date │ Plan     │ Amount   │ Status    │ Invoice        │   │
│ ├──────┼──────────┼──────────┼───────────┼────────────────┤   │
│ │May18 │ Growth   │ $49.00   │ ✅ Paid   │ [Download PDF] │   │
│ │Apr18 │ Growth   │ $49.00   │ ✅ Paid   │ [Download PDF] │   │
│ │Mar18 │ Starter  │ $19.00   │ ✅ Paid   │ [Download PDF] │   │
│ │Feb18 │ Free     │ $0.00    │ —         │ —              │   │
│ └──────┴──────────┴──────────┴───────────┴────────────────┘   │
│                                                               │
│ [← Previous]  Page 1 of 3  [Next →]                         │
└──────────────────────────────────────────────────────────────┘
```

- Columns: Date, Plan, Amount, Status (paid/pending/overdue/failed), Invoice download
- Status color: ✅ green for paid, 🟡 yellow for pending, 🔴 red for overdue/failed
- Pagination for history

---

## Cancellation Flow

### Step 1 — Save Survey

```
┌──────────────────────────────────────────────────────────────┐
│  We're sorry to see you go.                                   │
│                                                               │
│  What's the primary reason?                                   │
│                                                               │
│  ○ Too expensive                                              │
│  ○ Missing features                                           │
│  ○ Not using it enough                                        │
│  ○ Using a competitor                                         │
│  ○ Other                                                      │
│                                                               │
│  Any feedback?                                                │
│  [________________________________________________]          │
│                                                               │
│  [Never mind]  [Continue Cancellation →]                     │
└──────────────────────────────────────────────────────────────┘
```

### Step 2 — Confirmation

```
┌──────────────────────────────────────────────────────────────┐
│  ⚠️ Confirm Cancellation                                     │
│                                                               │
│  Your Advanced Support plan ($299/mo) will be cancelled.      │
│  You'll lose access to:                                       │
│  • All monitoring checks (paused)                            │
│  • Playbook history after 7 days                             │
│  • Audit logs                                                 │
│  • Team access                                                 │
│                                                               │
│  Your data will be retained for 30 days after cancellation.  │
│  You can reactivate anytime.                                  │
│                                                               │
│  [Keep My Plan]  [Confirm Cancellation]                      │
└──────────────────────────────────────────────────────────────┘
```

### Step 3 — Done

```
┌──────────────────────────────────────────────────────────────┐
│                                                               │
│                    [👋] Plan Cancelled                        │
│                                                               │
│  Your Advanced Support plan has been cancelled.               │
│  You'll have read-only access until June 17, 2026.            │
│  Your data is retained for 30 days.                           │
│                                                               │
│  [Go to Dashboard]  [Reactivate]                             │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**UX rules for cancellation:**
- Never show cancellation as the primary action — bury it in settings > billing > "Cancel Plan"
- Always collect feedback before confirming
- Always show what will be lost
- Always show data retention policy
- Always offer a reactivation path post-cancellation

---

## Empty / Loading States

| State | Treatment |
|-------|-----------|
| No payment method | Empty card with "Add Payment Method" prompt |
| No billing history | "No invoices yet" with illustration |
| Loading | Skeleton cards with animated pulse |
| Error fetching | Inline banner: "Failed to load billing data. [Retry]" |