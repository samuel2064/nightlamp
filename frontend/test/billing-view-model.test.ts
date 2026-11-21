// Focused tests for the NOC-236 billing view-model helpers. These assert the
// rules from the NOC-236 plan: server-declared commercial values, Stripe minor
// units converted for display, and a no-subscription read never rendered as a
// real zero-limit plan.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  accessLevelFor,
  currencyExponent,
  formatInvoiceAmount,
  formatInvoiceDate,
  formatPlanPrice,
  formatStorageMb,
  formatUsageValue,
  hasRenderableInvoiceLink,
  hasScheduledCancellation,
  isElevatedRole,
  isSafeInvoiceUrl,
  limitsAreKnown,
  limitsDeclareNoPlan,
  mutationOutcomeFor,
  pastDueCopy,
  subscriptionActionable,
  subscriptionLevelFor,
  usageRows,
} from '../src/lib/billing.ts'
import type {
  BillingSubscription,
  BillingUsage,
} from '../src/server/services/backend.ts'

const ACTIVE_SUBSCRIPTION: BillingSubscription = {
  planTier: 'advanced',
  status: 'active',
  currentPeriodStart: '2026-11-01T00:00:00.000Z',
  currentPeriodEnd: '2026-12-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
  limits: { monitors: 20, reports: 500, storageMb: 500 },
  price: 299,
  currency: 'usd',
  billingPeriod: 'month',
  nextBillingDate: '2026-12-01T00:00:00.000Z',
}

const USAGE: BillingUsage = {
  usage: { monitors: 2, reports: 100, storageMb: 128 },
  limits: { monitors: 5, reports: 100, storageMb: 100 },
  remaining: { monitors: 3, reports: 0, storageMb: 0 },
}

test('usage rows report ok, near and over from server values only', () => {
  const rows = usageRows(USAGE)
  assert.deepEqual(
    rows.map((row) => [row.key, row.used, row.limit, row.remaining, row.level]),
    [
      ['monitors', 2, 5, 3, 'ok'],
      ['reports', 100, 100, 0, 'over'],
      ['storageMb', 128, 100, 0, 'over'],
    ]
  )
})

test('a zeroed limit block with no subscription is a no-plan read, not a zero-limit plan', () => {
  const rows = usageRows({
    usage: { monitors: 0, reports: 0, storageMb: 0 },
    limits: { monitors: 0, reports: 0, storageMb: 0 },
    remaining: { monitors: 0, reports: 0, storageMb: 0 },
  })
  assert.equal(usageRows(null)[0].level, 'no_plan')
  assert.equal(rows[0].level, 'no_plan')
  assert.equal(rows.every((row) => row.level === 'no_plan'), true)
  assert.equal(limitsAreKnown({ monitors: 0, reports: 0, storageMb: 0 }), true)
  assert.equal(limitsAreKnown(null), false)
  assert.equal(limitsDeclareNoPlan({ monitors: 0, reports: 0, storageMb: 0 }), true)
  assert.equal(limitsDeclareNoPlan({ monitors: 5, reports: 100, storageMb: 100 }), false)
})

test('near-limit is 80% of the server limit', () => {
  const rows = usageRows({
    usage: { monitors: 4, reports: 0, storageMb: 0 },
    limits: { monitors: 5, reports: 100, storageMb: 100 },
    remaining: { monitors: 1, reports: 100, storageMb: 100 },
  })
  assert.equal(rows[0].level, 'near')
  assert.equal(rows[1].level, 'ok')
})

test('subscription levels separate scheduled cancellation from an active plan', () => {
  assert.equal(subscriptionLevelFor(null), 'none')
  assert.equal(subscriptionLevelFor(ACTIVE_SUBSCRIPTION), 'active')
  assert.equal(
    subscriptionLevelFor({ ...ACTIVE_SUBSCRIPTION, cancelAtPeriodEnd: true }),
    'scheduled_cancel'
  )
  assert.equal(subscriptionLevelFor({ ...ACTIVE_SUBSCRIPTION, status: 'past_due' }), 'past_due')
  assert.equal(subscriptionLevelFor({ ...ACTIVE_SUBSCRIPTION, status: 'trialing' }), 'trialing')
  assert.equal(
    subscriptionLevelFor({ ...ACTIVE_SUBSCRIPTION, status: 'canceled' }),
    'canceled'
  )
  assert.equal(
    subscriptionLevelFor({ ...ACTIVE_SUBSCRIPTION, status: 'some_new_status' }),
    'unknown'
  )
  assert.equal(pastDueCopy(ACTIVE_SUBSCRIPTION), null)
  assert.match(
    pastDueCopy({ ...ACTIVE_SUBSCRIPTION, status: 'past_due' }) ?? '',
    /past due/i
  )
})

test('only an owner or admin from the server may manage billing', () => {
  assert.equal(isElevatedRole('owner'), true)
  assert.equal(isElevatedRole('admin'), true)
  assert.equal(isElevatedRole('member'), false)
  assert.equal(isElevatedRole(null), false)
  assert.equal(isElevatedRole(undefined), false)
  assert.equal(accessLevelFor('admin'), 'owner_admin')
  assert.equal(accessLevelFor('member'), 'member')
  assert.equal(accessLevelFor(null), 'unavailable')
})

test('plan prices keep the server amount and the server currency', () => {
  assert.equal(formatPlanPrice(299, 'usd'), '$299')
  assert.equal(formatPlanPrice(99, 'usd'), '$99')
  assert.equal(formatPlanPrice(299.5, 'usd'), '$299.50')
  // No currency declared: the amount survives, no currency is invented.
  assert.equal(formatPlanPrice(299, ''), '299')
  assert.equal(formatPlanPrice(299, 'us'), '299')
})

test('invoice amounts are Stripe minor units scaled by the currency exponent', () => {
  // Two-decimal currency.
  assert.equal(formatInvoiceAmount(29900, 'usd'), '$299.00')
  assert.equal(formatInvoiceAmount(0, 'usd'), '$0.00')
  // Zero-decimal currency: JPY has no minor-unit scaling, so 500000 stays 500000.
  // The currency symbol varies between ICU versions, so the numeric part is
  // what is asserted; a two-decimal mis-scale would end in ',000.00'.
  assert.equal(currencyExponent('jpy'), 0)
  assert.equal(formatInvoiceAmount(500000, 'jpy').replace(/[^\d,]/g, ''), '500,000')
  // Three-decimal currency: KWD minor units are thousandths. The separator
  // between code and amount is ICU's narrow space, so the amount is compared
  // without symbol or spacing.
  assert.equal(currencyExponent('kwd'), 3)
  assert.equal(formatInvoiceAmount(12345, 'kwd').replace(/[^\d.,]/g, ''), '12.345')
  // A minor-unit amount with no usable server currency cannot be scaled honestly.
  assert.equal(currencyExponent(''), null)
  assert.equal(currencyExponent('us'), null)
  assert.equal(currencyExponent('usdd'), null)
  assert.equal(formatInvoiceAmount(29900, ''), 'Unknown currency')
  assert.equal(formatInvoiceAmount(29900, 'us'), 'Unknown currency')
  assert.equal(formatInvoiceAmount(29900, 'usdd'), 'Unknown currency')
})

test('invoice dates come from unix seconds, not milliseconds', () => {
  // 2026-11-01T00:00:00Z
  assert.equal(formatInvoiceDate(1793491200), 'Nov 1, 2026')
  assert.equal(formatInvoiceDate(0), '-')
})

test('storage formatting switches to GB and never renders a bare zero unit', () => {
  assert.equal(formatStorageMb(0), '0 MB')
  assert.equal(formatStorageMb(128), '128 MB')
  assert.equal(formatStorageMb(2048), '2 GB')
  assert.equal(formatUsageValue(5, 'monitors'), '5')
  assert.equal(formatUsageValue(500, 'storageMb'), '500 MB')
})

test('scheduled cancellation is reported independently of the subscription status', () => {
  assert.equal(hasScheduledCancellation(ACTIVE_SUBSCRIPTION), false)
  assert.equal(hasScheduledCancellation({ ...ACTIVE_SUBSCRIPTION, cancelAtPeriodEnd: true }), true)
  // A trialing or past-due plan can also be scheduled to end at period close.
  assert.equal(
    hasScheduledCancellation({ ...ACTIVE_SUBSCRIPTION, status: 'trialing', cancelAtPeriodEnd: true }),
    true
  )
  assert.equal(hasScheduledCancellation({ ...ACTIVE_SUBSCRIPTION, status: 'canceled' }), false)
  assert.equal(hasScheduledCancellation(null), false)
})

test('mutation-worthy states are exactly the statuses the billing service accepts', () => {
  assert.equal(subscriptionActionable(ACTIVE_SUBSCRIPTION), true)
  assert.equal(
    subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, cancelAtPeriodEnd: true }),
    true
  )
  assert.equal(subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, status: 'trialing' }), true)
  assert.equal(subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, status: 'past_due' }), true)
  // The backend refuses mutations for these, so the page offers no control.
  assert.equal(subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, status: 'canceled' }), false)
  assert.equal(subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, status: 'incomplete' }), false)
  assert.equal(
    subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, status: 'incomplete_expired' }),
    false
  )
  assert.equal(
    subscriptionActionable({ ...ACTIVE_SUBSCRIPTION, status: 'some_new_status' }),
    false
  )
  assert.equal(subscriptionActionable(null), false)
})

test('a failed mutation is definitive only when the server refused it outright', () => {
  assert.equal(mutationOutcomeFor('BAD_REQUEST'), 'rejected')
  assert.equal(mutationOutcomeFor('FORBIDDEN'), 'rejected')
  assert.equal(mutationOutcomeFor('NOT_FOUND'), 'rejected')
  assert.equal(mutationOutcomeFor('UNAUTHORIZED'), 'rejected')
  // A timeout, a 5xx, or an unparseable reply may have committed server-side.
  assert.equal(mutationOutcomeFor('INTERNAL_SERVER_ERROR'), 'indeterminate')
  assert.equal(mutationOutcomeFor('SERVICE_UNAVAILABLE'), 'indeterminate')
  assert.equal(mutationOutcomeFor('TIMEOUT'), 'indeterminate')
  assert.equal(mutationOutcomeFor('PARSE_ERROR'), 'indeterminate')
  assert.equal(mutationOutcomeFor(undefined), 'indeterminate')
  assert.equal(mutationOutcomeFor(null), 'indeterminate')
})

test('only absolute https invoice links are rendered as links', () => {
  assert.equal(isSafeInvoiceUrl('https://invoice.stripe.com/i/abc'), true)
  assert.equal(isSafeInvoiceUrl('http://invoice.stripe.com/i/abc'), false)
  assert.equal(isSafeInvoiceUrl('javascript:alert(1)'), false)
  assert.equal(isSafeInvoiceUrl(''), false)
  assert.equal(isSafeInvoiceUrl(null), false)

  const withLink = {
    status: 'paid',
    currency: 'usd',
    amountDue: 29900,
    amountPaid: 29900,
    created: 1761955200,
    invoiceUrl: 'https://invoice.stripe.com/i/abc',
    pdfUrl: null,
  }
  assert.equal(hasRenderableInvoiceLink(withLink), true)
  assert.equal(
    hasRenderableInvoiceLink({ ...withLink, invoiceUrl: 'http://evil.example', pdfUrl: null }),
    false
  )
})