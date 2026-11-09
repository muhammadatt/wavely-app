import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_BENEFITS, authCopy, featureVerb, proBenefits, offerFraming } from '../../src/auth/pitch.js'
import { FEATURES } from '../../src/auth/plans.js'

test('every account benefit is true of a free account', () => {
  assert.equal(new Set(ACCOUNT_BENEFITS.map(b => b.id)).size, ACCOUNT_BENEFITS.length, 'ids are unique keys')
  for (const b of ACCOUNT_BENEFITS) {
    if (!b.feature) continue
    assert.ok(FEATURES[b.feature], b.feature)
    assert.equal(FEATURES[b.feature].requires, 'free', b.feature)
  }
  // Not offered today, whatever plans.js says: mastering, spot-effect previews.
  assert.doesNotMatch(ACCOUNT_BENEFITS.map(b => b.text).join(' '), /master|preview/i)
})

test('the account dialog names the task that sent the user there', () => {
  assert.match(authCopy('signUp', 'mastering').title, /master the whole file/)
  assert.match(authCopy('signIn', 'savePresets').subtitle, /save your presets/)
  assert.equal(authCopy('signUp').title, 'Create your free account')
  assert.match(authCopy('signUp', 'autoLevel', 'autoLevel').title, /Step 1 of 2/)
  assert.match(authCopy('signIn', null, 'plan').subtitle, /checkout/)
  assert.equal(featureVerb('nonsense'), 'keep going')
  assert.equal(featureVerb('autoLevel'), 'use Auto Leveler')
  assert.equal(featureVerb('pluginChainApply'), 'use the Effect Chain')
})

test('Pro benefits come from shipped Pro operations, the requested one first', () => {
  const ops = [
    { id: 'a', label: 'Auto Leveler', desc: 'x', feature: 'autoLevel' },
    { id: 'n', label: 'Noise Reduction', desc: 'y', feature: 'noiseReduction' },
    { id: 'p', label: 'Peak', feature: undefined },
    { id: 's', label: 'Save', feature: 'savePresets' },
  ]
  const list = proBenefits(ops, 'noiseReduction')
  assert.deepEqual(list.map(i => i.feature), ['noiseReduction', 'autoLevel'])
  for (const i of list) assert.equal(FEATURES[i.feature].requires, 'pro')
})

test('yearly framing: per-month price and the saving, nothing claimed when it saves nothing', () => {
  const prices = [
    { plan: 'pro', interval: 'monthly', amount: 900, currency: 'usd' },
    { plan: 'pro', interval: 'yearly', amount: 9000, currency: 'usd' },
  ]
  assert.deepEqual(offerFraming(prices), { monthly: prices[0], yearly: prices[1], yearlyPerMonth: 750, savePercent: 16 })
  assert.equal(offerFraming([prices[0], { ...prices[1], amount: 10800 }]).savePercent, null)
  assert.equal(offerFraming([prices[1]]).savePercent, null)
  assert.equal(offerFraming([]).yearly, null)
})
