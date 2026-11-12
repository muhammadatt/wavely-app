import { test } from 'node:test'
import assert from 'node:assert/strict'

import { planSummary, subscriptionLine, formatPeriodDate } from '../../src/auth/accountSummary.js'

const END = '2026-11-21T12:00:00Z'
const sub = (over = {}) => ({ plan: 'pro', status: 'active', currentPeriodEnd: END, cancelAtPeriodEnd: false, ...over })
const date = formatPeriodDate(END, 'en-GB')

test('free (or a paid plan with no subscription record) offers the upgrade and says billing lives here', () => {
  for (const s of [planSummary('free', null, 'en-GB'), planSummary(null, null, 'en-GB'), planSummary('pro', null, 'en-GB')]) {
    assert.equal(s.paid, false)
    assert.equal(s.state, 'free')
    assert.equal(s.canManage, false)
    assert.match(s.detail, /manage and cancel/)
  }
})

test('an active subscription renews and can be managed and cancelled here', () => {
  const s = planSummary('pro', sub(), 'en-GB')
  assert.equal(s.label, 'Pro')
  assert.equal(s.state, 'active')
  assert.equal(s.canManage, true)
  assert.equal(s.status, `Renews ${date}.`)
  assert.match(s.detail, /cancel/)
  assert.match(s.detail, /without leaving the app/)
})

test('a cancelled subscription says when Pro ends and how to resume', () => {
  const s = planSummary('pro', sub({ cancelAtPeriodEnd: true }), 'en-GB')
  assert.equal(s.state, 'ending')
  assert.equal(s.status, `Cancelled — Pro stays on until ${date}.`)
  assert.match(s.detail, /Resume/)
})

test('a failed payment points at updating the card', () => {
  const s = planSummary('pro', sub({ status: 'past_due' }), 'en-GB')
  assert.equal(s.state, 'pastDue')
  assert.equal(s.canManage, true)
  assert.match(s.detail, /Update your card/)
})

test('trialing reads as a trial', () => {
  assert.equal(planSummary('pro', sub({ status: 'trialing' }), 'en-GB').state, 'trialing')
})

test('the menu line matches the old wording', () => {
  assert.equal(subscriptionLine(null), '')
  assert.equal(subscriptionLine(sub(), 'en-GB'), `Renews ${date}`)
  assert.equal(subscriptionLine(sub({ cancelAtPeriodEnd: true }), 'en-GB'), `Ends ${date}`)
  assert.equal(subscriptionLine(sub({ status: 'past_due' })), 'Payment failed — update your card')
  assert.equal(subscriptionLine(sub({ currentPeriodEnd: null })), '')
})

import { signInMethods, providerLabel } from '../../src/auth/accountSummary.js'

test('signInMethods lists identities, email first', () => {
  const user = {
    identities: [
      { provider: 'google', identity_data: { email: 'a@gmail.com' }, created_at: END },
      { provider: 'email', identity_data: { email: 'a@example.com' }, created_at: END },
    ],
  }
  const list = signInMethods(user, 'en-GB')
  assert.deepEqual(list.map(m => m.label), ['Email', 'Google'])
  assert.equal(list[1].email, 'a@gmail.com')
  assert.equal(list[1].since, date)
})

test('signInMethods falls back to app_metadata.providers', () => {
  assert.deepEqual(signInMethods({ app_metadata: { providers: ['github'] } }).map(m => m.label), ['GitHub'])
  assert.deepEqual(signInMethods(null), [])
  assert.equal(providerLabel('discord'), 'Discord')
})
