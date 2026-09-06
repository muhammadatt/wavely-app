/**
 * Run with:  npm test
 *
 * OPTOSMOOTH'S RELEASE — one reduction recovering fast then slowly.
 *
 * THE DEFECT THESE EXIST TO PREVENT COMING BACK. The release used to hold
 * `FAST_FRACTION` of the reduction in a fast stage and the rest in a slow one,
 * each decaying toward its OWN SHARE of the target. A stage that owns a fixed
 * share of the reduction and cannot follow anything at speech rates is a
 * PEDESTAL: constant attenuation applied to loud and quiet alike, doing nothing
 * for peaks and pulling the body down. Only the fast stage's share of the
 * static curve ever reached program.
 *
 * ⚠ THE SYMPTOM WAS A NUMBER, WHICH IS WHY IT IS TESTABLE. Delivered slope
 * divided by static slope came out at 68 % against a FAST_FRACTION of 0.65 —
 * the pedestal was measurable to two figures, and a reference capture delivers
 * 105 %. `npm run la2a:pairs` is where that ratio is measured on real dry/wet
 * pairs; this file pins the structural properties it depends on, which need no
 * corpus.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'

const SR = 44100
const db = v => 20 * Math.log10(Math.max(Math.abs(v), 1e-30))
const peak = (a, s, e) => { let m = 0; for (let i = s; i < e; i++) m = Math.max(m, Math.abs(a[i])); return m }

function run(x, peakReduction) {
  const k = new LA2AKernel(SR)
  k.setParams({ mode: 'compress', peakReduction, gainDb: 0, r37: 100, mix: 1 })
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += 128) {
    const l = Math.min(128, x.length - i)
    k.process([x.subarray(i, i + l)], [y.subarray(i, i + l)], l)
  }
  const L = k.latencySamples
  const a = new Float32Array(x.length)
  a.set(y.subarray(L), 0)
  return a
}

/** A tone that steps DOWN part-way through, so the release is what follows. */
function step(loudSec, quietSec, loudDb, quietDb) {
  const n = Math.round(SR * (loudSec + quietSec))
  const x = new Float32Array(n)
  const cut = Math.round(SR * loudSec)
  for (let i = 0; i < n; i++) {
    const amp = Math.pow(10, (i < cut ? loudDb : quietDb) / 20)
    x[i] = amp * Math.sin(2 * Math.PI * 1000 * i / SR)
  }
  return { x, cut }
}

test('the release recovers most of the reduction without stalling', () => {
  // ⚠ THE STALL IS THE PEDESTAL'S FINGERPRINT AND IS WHAT THIS CATCHES. The old
  // model's remaining reduction, normalised, went .402 at 100 ms -> .359 at
  // 200 -> .334 at 500: essentially flat, because what was left was the slow
  // stage sitting on its share. The reference falls .527 -> .345 -> .151 and
  // ours now .527 -> .333 -> .157.
  const { x, cut } = step(2, 3, -6, -60)
  const y = run(x, 78)
  const q = ms => peak(y, cut + Math.round(SR * ms / 1000), cut + Math.round(SR * (ms + 20) / 1000))
  const ref = peak(x, cut + 100, cut + SR)     // the quiet tone's own level
  // Reduction remaining, in dB, at three points down the tail.
  const at = ms => db(ref) - db(q(ms))
  const r100 = at(100), r200 = at(200), r500 = at(500)
  assert.ok(r100 > r200 && r200 > r500, `not monotone: ${r100.toFixed(2)} / ${r200.toFixed(2)} / ${r500.toFixed(2)} dB`)
  // The 200-500 ms leg must keep moving. A pedestal makes it nearly flat; the
  // old model shed 0.2 dB across it where this sheds several.
  assert.ok(r200 - r500 > 1, `only ${(r200 - r500).toFixed(2)} dB shed between 200 and 500 ms — the tail is stalling`)
})

test('the release is the same shape regardless of how long the cell was lit', () => {
  // ⚠ BOTH REFERENCES SAY SO AND OUR OLD MODEL DID NOT. Across a 200x
  // burst-length sweep the CLA-2A's release rows are identical to three figures
  // and LALA's are identical outright; ours varied a lot, leaving 0.114 against
  // 0.010 normalised at +5 s over the same sweep. That exposure dependence was
  // the LDR memory integrator, which is gone.
  const shape = loudSec => {
    const { x, cut } = step(loudSec, 3, -6, -60)
    const y = run(x, 78)
    const ref = peak(x, cut + 100, cut + SR)
    const at = ms => db(ref) - db(peak(y, cut + Math.round(SR * ms / 1000), cut + Math.round(SR * (ms + 20) / 1000)))
    const f = at(20)
    return [100, 200, 500, 1000].map(ms => at(ms) / f)
  }
  // ⚠ 0.3 s IS THE SHORT END, NOT 0.1, AND THAT IS THE PROBE'S LIMIT RATHER
  // THAN THE MODEL'S. At 0.1 s the cell is still attacking when the step down
  // arrives, so the reduction being released has not settled (9.29 dB at the
  // step against 7.97 for every longer burst) and the normalised shape moves
  // for that reason. 0.3 s to 4 s is still a 13x sweep, and over it the rows
  // are identical to three figures — hence a tolerance this tight.
  const short = shape(0.3)
  const long = shape(4)
  for (let i = 0; i < short.length; i++) {
    assert.ok(Math.abs(short[i] - long[i]) < 0.01,
      `exposure changed the release shape at index ${i}: ${short[i].toFixed(3)} vs ${long[i].toFixed(3)}`)
  }
})

test('sustained program keeps its reduction — the release does not decay to zero under signal', () => {
  // The release moves toward the TARGET, never toward zero. Getting this wrong
  // gives a limit cycle at the threshold rather than a compressor: gain would
  // sag away under a steady tone and be re-grabbed by the attack.
  const n = SR * 4
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.pow(10, -6 / 20) * Math.sin(2 * Math.PI * 1000 * i / SR)
  const y = run(x, 78)
  const early = db(peak(y, SR, SR + SR / 2))
  const late = db(peak(y, n - SR, n - 1))
  assert.ok(Math.abs(early - late) < 0.2,
    `steady tone drifted ${(late - early).toFixed(2)} dB between 1 s and 4 s`)
})
