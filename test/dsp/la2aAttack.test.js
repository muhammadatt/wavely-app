/**
 * Run with:  npm test
 *
 * OPTOSMOOTH'S PROGRAM-DEPENDENT ATTACK — the T4 does not have one attack time.
 *
 * The cell is an electroluminescent panel lighting a cadmium-sulfide
 * photoresistor, and a CdS cell's speed depends on the light it has already
 * absorbed. `la2aProcessor.js` blends between `ATTACK_DARK_S` and
 * `ATTACK_LIT_S` on how lit the cell is right now.
 *
 * ⚠ WHAT THESE TESTS CAN AND CANNOT DO. They pin the BEHAVIOUR — that the
 * attack varies at all, which way, and that it is not merely a faster fixed
 * attack. They do NOT validate the two constants: those are anchored to a
 * Waves CLA-2A capture that, as the constants' own ledger records, cannot fit
 * them, because our release keeps the cell state in too narrow a band for the
 * measurement to discriminate. Only a wider band or real hardware moves that.
 *
 * ⚠ AND THE `retrigger` PLAN IN `npm run la2a:ballistics` IS NOT A CHECK ON
 * THIS. It carries a +3.0 ms artefact in the opposite direction — a fixed
 * attack reads 14.4 -> 11.4 ms on it — so a raw spread from that harness cannot
 * confirm what this file asserts. These tests use onset depth instead, which
 * needs no `rest` reference and so has no such artefact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel, ATTACK_DARK_S, ATTACK_LIT_S } from '../../src/audio/la2aProcessor.js'

const SR = 44100
const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))

/**
 * A burst from 3 s of silence (the cell dark), then the SAME burst 0.4 s after
 * one (the cell still lit). The two onsets are identical by construction, so
 * any difference in how much of each survives is the cell's state and nothing
 * else.
 */
function twoOnsets() {
  const n = SR * 6
  const x = new Float32Array(n)
  const amp = Math.pow(10, -12 / 20)
  const dark = SR * 3
  const lit = SR * 3 + SR * 1 + Math.round(SR * 0.4)
  for (let i = 0; i < SR; i++) {
    const v = amp * Math.sin(2 * Math.PI * 1000 * i / SR)
    x[dark + i] = v
    x[lit + i] = v
  }
  return { x, dark, lit }
}

function onsetDepths(x, dark, lit) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', peakReduction: 78, gainDb: 0, r37: 100, mix: 1 })
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += 128) {
    const l = Math.min(128, x.length - i)
    k.process([x.subarray(i, i + l)], [y.subarray(i, i + l)], l)
  }
  // The oversampler delays the audio; compare like with like.
  const L = k.latencySamples
  const w = Math.round(SR * 0.005)
  const pk = (a, s) => { let m = 0; for (let i = s; i < s + w; i++) m = Math.max(m, Math.abs(a[i])); return db(m) }
  return {
    dark: pk(y, dark + L) - pk(x, dark),
    lit: pk(y, lit + L) - pk(x, lit),
  }
}

test('a lit cell catches an onset that a dark cell lets through', () => {
  const { x, dark, lit } = twoOnsets()
  const d = onsetDepths(x, dark, lit)
  // Direction first: this is the whole claim.
  assert.ok(d.lit < d.dark, `lit onset ${d.lit.toFixed(2)} dB is not caught harder than dark ${d.dark.toFixed(2)}`)
  // And by a margin worth having. Measured on the shipping constants:
  // -0.19 dB from dark, -5.89 dB when lit.
  assert.ok(d.dark - d.lit > 4, `only ${(d.dark - d.lit).toFixed(2)} dB between a dark and a lit onset`)
})

test('the dark onset is left as intact as a fixed 10 ms attack leaves it', () => {
  // ⚠ THE POINT OF THE WHOLE MECHANISM, AND THE THING A FIXED FAST ATTACK
  // CANNOT DO. Measured: fixed 10 ms -0.18 dB, fixed 1 ms -0.90, ours -0.19.
  // A fixed attack quick enough to move crest factor also clamps the first
  // transient, which is the behaviour an LA-2A is chosen for.
  const { x, dark, lit } = twoOnsets()
  const d = onsetDepths(x, dark, lit)
  assert.ok(d.dark > -0.5, `dark onset lost ${d.dark.toFixed(2)} dB; a fixed 10 ms attack loses 0.18`)
})

test('the two constants bracket the blend, and dark is the slow end', () => {
  // Guards the ordering rather than the values: swapping them would still
  // produce a working compressor, one that speeds up as the cell goes DARK.
  assert.ok(ATTACK_LIT_S < ATTACK_DARK_S, 'the lit cell must be the faster one')
  // 10 ms is the published nominal; 4.5 ms is the fastest t63 the CLA-2A
  // capture returns. Neither is free to drift silently.
  assert.equal(ATTACK_DARK_S, 0.010)
  assert.equal(ATTACK_LIT_S, 0.0045)
})
