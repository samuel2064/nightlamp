// Keyboard radio-group behaviour for the NPS and star scales (NOC-340
// remediation): one tab stop, arrow keys move and select, Home/End jump to the
// ends, movement wraps at both ends. The rule is pure so it is unit-tested.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { radioGroupKeyAction, radioGroupTargetIndex } from '../src/lib/feedback/radio-group-keys.ts'

test('the arrow, Home and End keys are the radio-group keys', () => {
  assert.equal(radioGroupKeyAction('ArrowRight'), 'next')
  assert.equal(radioGroupKeyAction('ArrowDown'), 'next')
  assert.equal(radioGroupKeyAction('ArrowLeft'), 'previous')
  assert.equal(radioGroupKeyAction('ArrowUp'), 'previous')
  assert.equal(radioGroupKeyAction('Home'), 'first')
  assert.equal(radioGroupKeyAction('End'), 'last')
  assert.equal(radioGroupKeyAction('Tab'), null)
  assert.equal(radioGroupKeyAction('Enter'), null)
  assert.equal(radioGroupKeyAction('a'), null)
})

test('arrow movement wraps at both ends of the 0-10 scale', () => {
  // Ascending order 0..10 by index: next from the last index wraps to the first.
  assert.equal(radioGroupTargetIndex('next', 10, 11), 0)
  assert.equal(radioGroupTargetIndex('next', 0, 11), 1)
  assert.equal(radioGroupTargetIndex('previous', 0, 11), 10)
  assert.equal(radioGroupTargetIndex('previous', 10, 11), 9)
  // A 5-star scale wraps the same way.
  assert.equal(radioGroupTargetIndex('next', 4, 5), 0)
  assert.equal(radioGroupTargetIndex('previous', 0, 5), 4)
})

test('Home and End jump to the ends without wrapping', () => {
  assert.equal(radioGroupTargetIndex('first', 7, 11), 0)
  assert.equal(radioGroupTargetIndex('last', 3, 11), 10)
  assert.equal(radioGroupTargetIndex('first', 0, 11), 0)
  assert.equal(radioGroupTargetIndex('last', 10, 11), 10)
})

test('an unhandled key and an empty group resolve to no target', () => {
  assert.equal(radioGroupTargetIndex(null, 4, 11), null)
  assert.equal(radioGroupTargetIndex('next', 0, 0), null)
})