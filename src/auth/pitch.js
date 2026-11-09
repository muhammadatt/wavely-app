/**
 * What the account and upgrade dialogs SAY — the reason, the benefits and the
 * price framing — as pure functions over the feature table, so the copy cannot
 * promise something plans.js does not grant, and so it is testable under
 * `node --test` (the dialogs themselves import Vue components and the registry).
 *
 * ⚠ Every benefit line here must be true of `FEATURES`. A "free" claim that the
 * server then refuses is worse for conversion than no claim at all.
 */

import { FEATURES, PLAN_LABELS } from './plans.js'

/**
 * What a free account gives, in the order a first-time visitor cares about.
 * A line that rests on a feature names it (`feature`), and a test checks that
 * feature is free-tier; a line with no feature is a promise about the account
 * itself (`id`), not a gate in plans.js.
 *
 * ⚠ Deliberately NOT here while they are not offered: mastering (not launched)
 * and short-clip previews of server spot effects (withdrawn), even though
 * plans.js still describes both.
 */
export const ACCOUNT_BENEFITS = [
  { id: 'presets', feature: 'savePresets', text: 'Save custom presets and effect settings' },
  { id: 'earlyAccess', text: 'Get early access to new effects' },
]

/**
 * Title and subtitle for the account dialog. With a `reason` (the feature that
 * sent the user here) the copy says what signing up unlocks NOW, instead of a
 * generic "sign in" — the user was mid-task and should see the task named.
 *
 * @param {string}      mode         'signIn' | 'signUp' | 'reset' | 'recovery'
 * @param {string|null} reason       feature id
 * @param {string|null} thenUpgrade  feature id ('plan' = Pro) the prompt resumes to
 */
export function authCopy(mode, reason = null, thenUpgrade = null) {
  const feature = reason ? FEATURES[reason] ?? null : null
  if (mode === 'reset') return { title: 'Reset your password', subtitle: 'We’ll email you a link to set a new one.' }
  if (mode === 'recovery') return { title: 'Choose a new password', subtitle: 'You’re signed in from your reset link — set a password to finish.' }

  if (thenUpgrade) {
    const plan = PLAN_LABELS.pro
    return mode === 'signIn'
      ? { title: 'Sign in to upgrade', subtitle: `You’ll go straight on to ${plan} checkout.` }
      : { title: `Step 1 of 2: create your account`, subtitle: `Free, takes a few seconds. You’ll choose your ${plan} plan next.` }
  }

  if (mode === 'signIn') {
    return feature
      ? { title: 'Welcome back', subtitle: `Sign in to ${featureVerb(reason)}.` }
      : { title: 'Welcome back', subtitle: 'Sign in to pick up your presets and plan.' }
  }
  return feature
    ? { title: `Create a free account to ${featureVerb(reason)}`, subtitle: 'No credit card. Your audio stays right here in the editor.' }
    : { title: 'Create your free account', subtitle: 'No credit card. Your audio stays right here in the editor.' }
}

/** "master the whole file" — what the user was trying to do, as a verb phrase. */
export function featureVerb(featureId) {
  switch (featureId) {
    case 'mastering': return 'master the whole file'
    case 'savePresets': return 'save your presets'
    case 'audioAnalysis': return 'analyse your audio'
    case 'spotEffects': return 'use this effect'
    default: {
      const label = FEATURES[featureId]?.label
      // Product names stay capitalised ("use Auto Leveler"); only an article drops.
      return label ? `use ${label.replace(/^The /, 'the ')}` : 'keep going'
    }
  }
}

/**
 * The Pro plan's selling points, from the operations this build ships (a
 * dev-only plugin is not a selling point), the feature that opened the prompt
 * first. Each: { title, desc }.
 *
 * @param {Array}       operations  the registry's OPERATIONS
 * @param {string|null} featureId   the feature that opened the prompt
 */
export function proBenefits(operations, featureId = null) {
  const items = []
  const seen = new Set()
  for (const op of operations) {
    const id = op.feature
    if (!id || FEATURES[id]?.requires !== 'pro' || seen.has(id)) continue
    seen.add(id)
    items.push({ feature: id, title: op.label, desc: op.desc ?? '' })
  }
  // The feature the user reached for leads the list.
  const lead = items.findIndex(i => i.feature === featureId)
  if (lead > 0) items.unshift(...items.splice(lead, 1))
  return items
}

/**
 * Monthly vs. yearly, framed: the yearly price per month and what it saves
 * against twelve monthly payments (a whole percent, null when it saves nothing
 * or either price is missing).
 *
 * @param {Array} prices  [{ plan, interval, amount, currency }] in minor units
 */
export function offerFraming(prices, plan = 'pro') {
  const by = Object.fromEntries((prices ?? []).filter(p => p.plan === plan).map(p => [p.interval, p]))
  const monthly = by.monthly ?? null
  const yearly = by.yearly ?? null
  const yearlyPerMonth = yearly ? Math.round(yearly.amount / 12) : null
  let savePercent = null
  if (monthly && yearly && monthly.currency === yearly.currency && monthly.amount > 0) {
    const pct = Math.floor((1 - yearly.amount / (monthly.amount * 12)) * 100)
    if (pct >= 1) savePercent = pct
  }
  return { monthly, yearly, yearlyPerMonth, savePercent }
}
