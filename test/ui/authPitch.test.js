import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ACCOUNT_BENEFITS, authCopy, featureVerb, PRO_BENEFITS, offerFraming } from '../../src/auth/pitch.js'
import { FEATURES } from '../../src/auth/plans.js'
import { passwordScore, passwordStrength, MIN_PASSWORD } from '../../src/auth/passwordStrength.js'

test('every account benefit is true of a free account', () => {
  assert.equal(new Set(ACCOUNT_BENEFITS.map(b => b.id)).size, ACCOUNT_BENEFITS.length, 'ids are unique keys')
  for (const b of ACCOUNT_BENEFITS) {
    if (!b.feature) continue
    assert.ok(FEATURES[b.feature], b.feature)
    assert.equal(FEATURES[b.feature].requires, 'free', b.feature)
  }
  // Not offered today, whatever plans.js says: mastering, spot-effect previews.
  assert.doesNotMatch(ACCOUNT_BENEFITS.map(b => `${b.title} ${b.text}`).join(' '), /master|preview/i)
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

test('Pro value props name only Pro features, and each has its own icon', () => {
  for (const b of PRO_BENEFITS) {
    for (const id of b.features) assert.equal(FEATURES[id]?.requires, 'pro', id)
  }
  assert.deepEqual(PRO_BENEFITS.map(b => b.icon), ['star', 'chain', 'heart'])
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

test('password meter: length first, mixes add, and it never reads below weak once typed', () => {
  assert.equal(passwordScore(''), 0)
  assert.equal(passwordScore('abc'), 1)
  assert.equal(passwordScore('abcdefgh'), 1)
  assert.equal(passwordScore('abcdefghijkl'), 2)
  assert.equal(passwordScore('Abcdefghijkl'), 3)
  assert.equal(passwordScore('Abcdefghijk1'), 4)
  assert.equal(passwordStrength('abc').hint, `${MIN_PASSWORD - 3} more characters`)
  assert.equal(passwordStrength('abcdefg').hint, '1 more character')
  assert.equal(passwordStrength('abcdefgh').weak, true)
  assert.equal(passwordStrength('').hint, `At least ${MIN_PASSWORD} characters`)
})
