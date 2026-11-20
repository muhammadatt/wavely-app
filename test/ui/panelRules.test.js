/**
 * Small per-plugin rules that moved out of the panels (docs/plugin-panel-audit.md,
 * step 5): what the window frame and each plugin DECIDE, tested without a
 * component.
 *
 * Run with:  npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { applyGate } = await import('../../src/ui/applyGate.js')
const { hasGainTerm, nudgeQ, Q_NUDGE } = await import('../../src/audio/eqBands.js')
const { inflatorLiftDb, inflatorMaxLiftDb, CURVE_MAX_PCT } = await import('../../src/audio/inflatorParams.js')
const { TAPE_SPEEDS, HF_PANEL_DETENTS } = await import('../../src/audio/phatassParams.js')
const {
  DE_ESSER_DEFAULTS, DE_ESSER_AMOUNT_DEFAULT, DE_ESSER_SPLIT_DEFAULT, splitAmount,
} = await import('../../src/audio/deEsserParams.js')

const open = {
  inChain: null, busy: false, applyDisabled: false, applyDisabledHint: 'off',
  requiresSelection: true, hasSelection: true, locked: false, lockedHint: '', offline: false,
}

test('Apply runs when nothing stands in its way', () => {
  assert.deepEqual(applyGate(open), { blocked: false, title: '' })
})

test('Apply is blocked by the chain, a busy file, the panel and a missing selection, first reason first', () => {
  assert.equal(applyGate({ ...open, inChain: { slot: 1 }, busy: true }).title,
    'This plugin is in the Effect Chain — apply it from the chain')
  assert.equal(applyGate({ ...open, busy: true, applyDisabled: true }).title,
    'This file is still being processed — wait for it to finish')
  assert.deepEqual(applyGate({ ...open, applyDisabled: true, hasSelection: false }), { blocked: true, title: 'off' })
  assert.deepEqual(applyGate({ ...open, hasSelection: false }),
    { blocked: true, title: 'Select audio to apply this effect to' })
  assert.equal(applyGate({ ...open, requiresSelection: false, hasSelection: false }).blocked, false)
})

test('a locked Apply is not blocked — clicking it asks for the plan — and an offline one promises no preview', () => {
  const locked = applyGate({ ...open, locked: true, lockedHint: 'Pro' })
  assert.deepEqual(locked, { blocked: false, title: 'Pro — preview is free' })
  assert.equal(applyGate({ ...open, locked: true, lockedHint: 'Pro', offline: true }).title, 'Pro')
})

test('EQ: only notch / high-pass / low-pass have no gain term, and a Q nudge is multiplicative and reversible', () => {
  for (const t of ['notch', 'highpass', 'lowpass']) assert.equal(hasGainTerm(t), false, t)
  for (const t of ['peaking', 'lowshelf', 'highshelf']) assert.equal(hasGainTerm(t), true, t)
  assert.equal(nudgeQ(2, 1), 2 * Q_NUDGE)
  assert.ok(Math.abs(nudgeQ(nudgeQ(0.7, 1), -1) - 0.7) < 1e-12)
})

test('Cambridge Inflator: the most lift is the curve’s at Effect 100 % and none at 0', () => {
  assert.ok(Math.abs(inflatorMaxLiftDb(CURVE_MAX_PCT, 1) - inflatorLiftDb(CURVE_MAX_PCT)) < 1e-12)
  assert.equal(inflatorMaxLiftDb(CURVE_MAX_PCT, 0), 0)
  assert.ok(inflatorMaxLiftDb(0, 0.5) < inflatorMaxLiftDb(0, 1))
})

test('PHATaSS: every panel speed has a reel time, halving each speed doubling it', () => {
  const s = HF_PANEL_DETENTS.map(id => TAPE_SPEEDS[id].reelSeconds)
  assert.deepEqual(s, [1.6, 3.2, 6.4])
})

test('De-Esser: the panel’s Amount / Split defaults are the shipping Duck / EQ', () => {
  // Amount 60 / Split 33 (CLAUDE.md). Split is a whole percent, so the round
  // trip lands within half a point of Duck 40 / EQ 20, not on it.
  assert.equal(DE_ESSER_AMOUNT_DEFAULT, 60)
  assert.equal(DE_ESSER_SPLIT_DEFAULT, 33)
  const { duck, amount } = splitAmount(DE_ESSER_AMOUNT_DEFAULT, DE_ESSER_SPLIT_DEFAULT)
  assert.ok(Math.abs(duck - DE_ESSER_DEFAULTS.duck) <= 0.5)
  assert.ok(Math.abs(amount - DE_ESSER_DEFAULTS.amount) <= 0.5)
})
