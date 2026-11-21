import { test } from 'node:test'
import assert from 'node:assert/strict'
import { npsCategoryForScore } from '../src/lib/feedback/contract.ts'

test('smoke: type stripping + node:test work', () => {
  assert.equal(npsCategoryForScore(10), 'promoter')
  assert.equal(npsCategoryForScore(7), 'passive')
  assert.equal(npsCategoryForScore(3), 'detractor')
})
