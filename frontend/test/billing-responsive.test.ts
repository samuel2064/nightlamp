// Static mobile and accessibility contract for the NOC-236 billing surface.
//
// This lane reads the shipped sources and asserts the class contracts the page
// commits to: 44px hit areas, 16px controls, a table that scrolls inside its card
// instead of overflowing the page, named dialogs, and a reduced-motion block. It
// is a source contract, NOT a rendered-viewport capture: a controlled browser
// run at 320px and 375px still needs an authenticated session and is reported
// separately on the ticket.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const read = (relative: string) =>
  readFileSync(join(here, '..', relative), 'utf8')

const PAGE = read('src/app/dashboard/billing/page.tsx')
const PLAN_DIALOG = read('src/components/dashboard/plan-change-dialog.tsx')
const CANCEL_DIALOG = read('src/components/dashboard/cancel-subscription-dialog.tsx')
const GLOBALS = read('src/app/globals.css')

/** Split on an opening tag so multi-line JSX props are checked together. */
function chunksAfter(source: string, marker: string): string[] {
  const parts = source.split(marker)
  return parts.slice(1).map((part) => part.slice(0, 400))
}

test('every billing control is at least a 44x44 hit area', () => {
  const surface = [PAGE, PLAN_DIALOG, CANCEL_DIALOG].join('\n')
  const buttons = chunksAfter(surface, '<Button')
  assert.ok(buttons.length >= 4, `expected several buttons, found ${buttons.length}`)
  for (const chunk of buttons) {
    assert.ok(chunk.includes('min-h-11'), 'a Button has no 44px hit area')
  }
  const selects = chunksAfter(surface, '<SelectTrigger')
  assert.ok(selects.length >= 1)
  for (const chunk of selects) {
    assert.ok(chunk.includes('min-h-11'), 'the plan select has no 44px hit area')
  }
})

test('invoice and PDF links are 44px tall', () => {
  const links = chunksAfter(PAGE, '<a\n')
  assert.ok(links.length >= 2, `expected two invoice links, found ${links.length}`)
  for (const chunk of links) {
    assert.ok(chunk.includes('min-h-11'), 'an invoice link is shorter than 44px')
  }
})

test('form controls are 16px so mobile browsers do not zoom on focus', () => {
  assert.match(PLAN_DIALOG, /SelectTrigger[^>]*min-h-11[^>]*text-base/)
})

test('the invoice table scrolls inside its card and never widens the page', () => {
  assert.match(PAGE, /overflow-x-auto/)
  assert.match(PAGE, /min-w-\[/)
  // No fixed viewport-width element on the page root.
  assert.doesNotMatch(PAGE, /w-screen|min-w-screen/)
})

test('usage bars expose a value to assistive technology', () => {
  assert.ok(PAGE.includes('aria-label='), 'the usage bar has no accessible name')
  assert.ok(/<Progress[\s\S]{0,400}aria-label=/.test(PAGE), 'Progress carries no aria-label')
})

test('status is never colour alone', () => {
  // Every badge has a text label and every usage warning carries an icon.
  assert.match(PAGE, /<Badge/)
  assert.match(PAGE, /\{statusCopy\.label\}/)
  assert.match(PAGE, /<AlertTriangle/)
  assert.match(PAGE, /<CheckCircle2/)
})

test('both confirmation dialogs are named for assistive technology', () => {
  for (const source of [PLAN_DIALOG, CANCEL_DIALOG]) {
    assert.match(source, /<AlertDialogTitle>/)
    assert.match(source, /<AlertDialogDescription>/)
    assert.match(source, /<AlertDialogContent>/)
  }
})

test('confirmation copy never claims immediate cancellation', () => {
  assert.match(CANCEL_DIALOG, /end of the current billing period/)
  assert.match(CANCEL_DIALOG, /nothing is\s+cancelled immediately/i)
})

test('reduced motion is honoured', () => {
  assert.match(GLOBALS, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(GLOBALS, /transition-duration: 0\.01ms/)
})

test('no hard-coded commercial value, tier alias or limit is declared in the surface', () => {
  const surface = [PAGE, PLAN_DIALOG, CANCEL_DIALOG].join('\n')
  // Amounts like $99/$299/$499 and tier ids must never appear as literals.
  assert.doesNotMatch(surface, /\$\s?(99|199|299|349|499)\b/)
  assert.doesNotMatch(surface, /'(basic|advanced|white_glove)'/)
  assert.doesNotMatch(surface, /"(basic|advanced|white_glove)"/)
  // Currency and period are server-declared; only an empty-string default is allowed.
  assert.doesNotMatch(surface, /currency(?:Currency)?\s*[:=]\s*['"]usd['"]/i)
  assert.doesNotMatch(surface, /formatPeriod\(['"](month|year|week|day)['"]\)/)
})

test('no raw Stripe identifier is rendered', () => {
  const surface = [PAGE, PLAN_DIALOG, CANCEL_DIALOG].join('\n')
  assert.doesNotMatch(surface, /stripeSubscriptionId|stripeCustomerId|customerId/)
  // The invoice number is customer-visible; the invoice row id is not.
  assert.match(PAGE, /invoice\.number/)
  assert.doesNotMatch(PAGE, /invoice\.id\b/)
})