# Tenant-scoped billing API (NOC-235)

All customer-facing routes require a verified bearer token. The server resolves
the local customer with `tenantFilter` using the authenticated team, then reads
the Stripe customer ID from that record. Legacy personal customer lookup also
requires the verified local user's email. Client identity selectors (`customerId`,
`teamId`, `orgId`, `stripeCustomerId`, `subscriptionId`) are rejected with 400.

| Method | Route | Access | Response / input |
| --- | --- | --- | --- |
| GET | `/api/billing/subscription` | Members | `{ subscription }`, including tier, status, price in USD dollars, monthly billing period, limits, period dates, cancellation flag and next billing date |
| GET | `/api/billing/usage` | Members | `{ usage, limits, remaining }` for monitors, reports and storage MB |
| GET | `/api/billing/invoices` | Members | `{ invoices, hasMore }`; latest 50 Stripe invoices for this customer, monetary amounts in Stripe minor units |
| GET | `/api/billing/portal` | Owner/admin | `{ url }`; Stripe Customer Portal session with server-controlled return URL |
| POST | `/api/billing/change-plan` | Owner/admin | `{ "planTier": "basic" \| "advanced" \| "white_glove" }`; returns updated `{ subscription }` |
| POST | `/api/billing/cancel` | Owner/admin | `{}`; schedules cancellation at period end and returns updated `{ subscription }` |
| POST | `/api/billing/create-checkout-session` | Owner/admin | `{ "planTier": "basic" \| "advanced" \| "white_glove" }`; uses the existing locally linked Stripe customer |
| POST | `/api/billing/customer` | Owner/admin | `{ "email": "...", "name": "..." }`; returns an existing tenant customer or creates a tenant-owned local record |

Prices and limits use the existing $99/$299/$499 `PLAN_TIERS` definitions.
No linked customer/subscription returns `subscription: null`, zero usage/limits,
or an empty invoice list; portal and subscription mutations return 404 when the
required Stripe mapping is absent. Mutations and portal access return 403 for
members and users without an elevated team role.

Plan changes replace the existing single Stripe subscription item. The API
checks its Stripe customer against the locally resolved customer before writing.
It leaves `proration_behavior` unspecified to preserve Stripe's existing/default
policy and uses `payment_behavior: error_if_incomplete`. Local plan and
cancellation state is updated only after Stripe accepts the operation; upstream
mutation failures return 502. Cancellation preserves current status and sets
`cancelAtPeriodEnd`; the next billing date becomes null.

The frontend's existing protected billing router can continue using its summary,
subscriptions and portal calls. The routes above are available for detailed
usage/history and plan-change UI wiring.

## Verification

`src/test/api-authorization.test.ts` exercises both tenants, member reads,
foreign identity rejection, owner-only portal and mutations, no-membership
denials, Stripe customer mismatch, upstream failure atomicity, cancellation and
plan-tier validation. `src/test/billing.test.ts` covers the ID-free billing
contract and the existing Stripe/model/webhook behavior.
