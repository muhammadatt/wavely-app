/**
 * Run with:  npm test
 *
 * INPUT ALIGNMENT — the side-chain drive offset that makes a knob position mean
 * the same thing on every file.
 *
 * ⚠ THE LOAD-BEARING TEST IS `is exactly an input gain`. The whole safety
 * argument for this feature is that a drive offset and an input gain are the
 * same thing to the detector and different things everywhere else — that is why
 * there is no output trim to cancel, no preview/apply drift, and no tube shift.
 * If that equivalence ever stops holding, the feature's justification is gone
 * and the rest of these tests will still pass, so it is asserted directly
 * against the kernel rather than argued in a comment.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  gatedRmsOfChannels, inputAlignDbFor,
  ALIGN_TARGET_DBFS, ALIGN_MAX_DB, ALIGN_GATE_RANGE_DB, ALIGN_BLOCK_MS,
  INPUT_TRIM_MAX_DB,
} from '../../src/audio/dsp/inputAlign.js'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'

const SR = 44100
const db = (v) => 20 * Math.log10(v)

/** Speech-shaped: onsets, decays and gaps, so the gate has something to gate. */
function speech(seconds, peakDbfs, seed = 12345) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const ph = t % 0.6
    const burst = ph < 0.35 ? Math.min(1, ph / 0.004) * Math.exp(-ph * 2.5) : 0
    x[i] = burst * (0.6 * Math.sin(2 * Math.PI * 180 * t)
      + 0.25 * Math.sin(2 * Math.PI * 900 * t) + 0.15 * rnd())
  }
  let pk = 0
  for (const v of x) pk = Math.max(pk, Math.abs(v))
  const g = Math.pow(10, peakDbfs / 20) / pk
  for (let i = 0; i < n; i++) x[i] = Math.fround(x[i] * g)
  return x
}

const scaled = (x, gainDb) => {
  const g = Math.pow(10, gainDb / 20)
  const y = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) y[i] = Math.fround(x[i] * g)
  return y
}

function render(x, params) {
  const k = new LA2AKernel(SR)
  k.setParams({
    mode: 'compress', peakReduction: 50, gainDb: 0, r37: 100, mix: 1,
    lookaheadMs: 0, tube: false, cellMod: 0, oversample: false, ...params,
  })
  const out = new Float32Array(x.length)
  for (let i = 0; i < x.length; i += 128) {
    const n = Math.min(128, x.length - i)
    k.process([x.subarray(i, i + n)], [out.subarray(i, i + n)], n)
  }
  return { out, avgGr: k.grActive ? k.grSum / k.grActive : 0 }
}

/**
 * ⚠ THE GAIN MUST BE EXACTLY REPRESENTABLE OR THIS TEST CANNOT BE EXACT. At an
 * arbitrary offset — 12 dB, say — the two paths differ by ~1e-9 in average gain
 * reduction, and that residual is float32 STORAGE of the scaled input, not the
 * kernel diverging: `scaled()` rounds every sample, the drive offset rounds
 * nothing. x2 is exact in binary, so the input scaling is lossless and the
 * equivalence can be asserted as bit-identity rather than as a tolerance
 * somebody would later have to widen. The non-representable case is covered
 * separately below, loosely, because loose is all it can be.
 */
const EXACT_2X_DB = 6.020599913279624

test('a drive offset is exactly an input gain, to the detector', () => {
  const x = speech(3, -18)
  const viaOffset = render(x, { inputAlignDb: EXACT_2X_DB })
  const viaGain = render(scaled(x, EXACT_2X_DB), {})

  // The applied gain curve, sample by sample, as a ratio so the input scaling
  // divides out. THIS is the exact claim: the rendered output is bit-identical.
  let compared = 0
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) < 1e-5) continue
    assert.equal(viaOffset.out[i] / x[i], viaGain.out[i] / (x[i] * 2))
    compared++
  }
  assert.ok(compared > 1000, 'stimulus must actually exercise the gain path')

  // ⚠ THE INTERNAL STATISTIC IS *NOT* BIT-IDENTICAL AND CANNOT BE, so it is
  // asserted loosely on purpose rather than tightened later by someone reading
  // this as a flake. `avgGr` is a float64 accumulation of `20*log10(env)`, and
  // log10(2*env) differs from log10(env) + 20*log10(2) by one ULP — doubling
  // the input is exact, taking its logarithm is not. It rounds away entirely by
  // the time it reaches the float32 output, which is why the loop above can be
  // exact while this line cannot.
  assert.ok(Math.abs(viaOffset.avgGr - viaGain.avgGr) < 1e-12,
    `avg GR ${viaOffset.avgGr} vs ${viaGain.avgGr}`)
})

test('the equivalence survives a non-representable offset', () => {
  const x = speech(3, -18)
  const viaOffset = render(x, { inputAlignDb: 12 })
  const viaGain = render(scaled(x, 12), {})
  // Only float32 rounding of the scaled input separates them; the bound is
  // loose because it has to be, and the test above is the exact one.
  assert.ok(Math.abs(viaOffset.avgGr - viaGain.avgGr) < 1e-6,
    `avg GR ${viaOffset.avgGr} vs ${viaGain.avgGr}`)
})

test('a drive offset does NOT touch the audio path', () => {
  // The counterpart to the test above, and the reason this is a drive offset
  // rather than an input gain: with the offset at 0 the kernel is untouched,
  // so nothing downstream (tube, ceiling, makeup) can drift on it.
  const x = speech(1, -18)
  const a = render(x, { inputAlignDb: 0, tube: true, cellMod: 1, oversample: true })
  const b = render(x, { tube: true, cellMod: 1, oversample: true })
  for (let i = 0; i < x.length; i++) assert.equal(a.out[i], b.out[i])
})

test('alignment holds gain reduction constant across input level', () => {
  const base = speech(4, -1)
  const grs = []
  for (const level of [0, -6, -12, -18, -24, -30]) {
    const x = scaled(base, level)
    const trim = inputAlignDbFor([x], SR)
    grs.push(render(x, { inputAlignDb: trim, tube: true, cellMod: 1, oversample: true }).avgGr)
  }
  const spread = Math.max(...grs) - Math.min(...grs)
  assert.ok(spread < 0.05, `GR spread across 30 dB of input level: ${spread}`)

  // ...and that it is a real fix, not a constant zero. Unaligned, the same
  // sweep collapses to nothing well before the bottom of the range.
  const unaligned = [0, -30].map((l) => render(scaled(base, l), {}).avgGr)
  assert.ok(unaligned[0] - unaligned[1] > 1,
    `unaligned sweep should collapse, got ${unaligned}`)
})

test('the trim is the level difference, and it is signed correctly', () => {
  const x = speech(3, -6)
  const at = inputAlignDbFor([x], SR)
  assert.ok(Math.abs(at - (ALIGN_TARGET_DBFS - db(gatedRmsOfChannels([x], SR)))) < 1e-9)
  // Quieter file -> more drive.
  assert.ok(inputAlignDbFor([scaled(x, -12)], SR) > at)
  // 12 dB quieter asks for 12 dB more, exactly.
  assert.ok(Math.abs(inputAlignDbFor([scaled(x, -12)], SR) - (at + 12)) < 1e-4)
})

test('the trim is clamped, symmetrically', () => {
  assert.equal(inputAlignDbFor([speech(3, -6, 7).map((v) => Math.fround(v * 1e-5))], SR),
    ALIGN_MAX_DB)
  assert.equal(inputAlignDbFor([speech(3, -6, 7).map((v) => Math.fround(v * 1e5))], SR),
    -ALIGN_MAX_DB)
})

test('gated RMS ignores room tone below the gate', () => {
  // The failure that made the gate necessary: a narrator's file with long head
  // and tail room tone reads far too quiet on plain RMS, so alignment
  // over-drives it. The gate must make the padded file measure the same as the
  // unpadded one.
  const x = speech(4, -6)
  const padSamples = SR * 8
  const padded = new Float32Array(x.length + 2 * padSamples)
  let s = 4242
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  const floor = Math.pow(10, -55 / 20)
  for (let i = 0; i < padded.length; i++) padded[i] = Math.fround(floor * rnd())
  padded.set(x, padSamples)

  const bare = db(gatedRmsOfChannels([x], SR))
  const withTone = db(gatedRmsOfChannels([padded], SR))
  assert.ok(Math.abs(bare - withTone) < 0.5,
    `16 s of room tone moved the measurement by ${(withTone - bare).toFixed(2)} dB`)

  // Plain RMS is what this beats: assert the gate is actually doing work, so
  // the test fails if someone quietly removes it.
  let sum = 0
  for (const v of padded) sum += v * v
  const plain = db(Math.sqrt(sum / padded.length))
  assert.ok(withTone - plain > 3,
    'gate should read well above plain RMS on a tone-padded file')
})

test('gated RMS is scale-covariant', () => {
  const x = speech(3, -12)
  const a = gatedRmsOfChannels([x], SR)
  const b = gatedRmsOfChannels([scaled(x, -20)], SR)
  assert.ok(Math.abs(db(b) - (db(a) - 20)) < 1e-3)
})

/**
 * ⚠ THESE THREE ARE ONE REGRESSION, AND ONLY THE LAST TWO HAVE TEETH. The first
 * cut measured mean per-channel power, sqrt((L^2 + R^2)/2), which agrees with
 * the kernel's `(L + R)/nCh` tap for mono and for identical L/R and disagrees
 * for everything else — so the duplicated-channel case below PASSED against a
 * wrong measurement. Opposed and unequal channels are what separate the two.
 */
test('gated RMS sums channels as the mono side-chain tap does', () => {
  const x = speech(2, -12)
  const mono = gatedRmsOfChannels([x], SR)
  const dual = gatedRmsOfChannels([x, x], SR)
  assert.ok(Math.abs(db(dual) - db(mono)) < 1e-9,
    'duplicating a channel must not change the measured level')
})

test('opposed channels measure as the silence the detector would see', () => {
  const x = speech(2, -12)
  const flipped = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) flipped[i] = Math.fround(-x[i])
  // (L + -L)/2 is zero at every sample, so the cell never lights. A per-channel
  // power average reads this as full level and would align it like ordinary
  // programme.
  assert.equal(gatedRmsOfChannels([x, flipped], SR), 0)
  assert.equal(inputAlignDbFor([x, flipped], SR), 0)
})

test('a dead channel halves the measured level, as the tap does', () => {
  // An ordinary recording, not a contrived one: one mic into a stereo file.
  // (L + 0)/2 is exactly 6.02 dB below L. The per-channel power average read
  // this 3.01 dB hot.
  const x = speech(3, -12)
  const dead = new Float32Array(x.length)
  const oneSided = db(gatedRmsOfChannels([x, dead], SR))
  const mono = db(gatedRmsOfChannels([x], SR))
  assert.ok(Math.abs((mono - oneSided) - 6.0206) < 0.05,
    `expected 6.02 dB below mono, got ${(mono - oneSided).toFixed(3)}`)
})

test('an unequal pair measures its actual sum', () => {
  const x = speech(3, -12)
  const half = new Float32Array(x.length)
  for (let i = 0; i < x.length; i++) half[i] = Math.fround(x[i] * 0.5)
  // (L + L/2)/2 = 0.75 L.
  const got = db(gatedRmsOfChannels([x, half], SR))
  const want = db(gatedRmsOfChannels([x], SR)) + 20 * Math.log10(0.75)
  assert.ok(Math.abs(got - want) < 0.01, `got ${got}, want ${want}`)
})

test('degenerate input cannot produce a trim', () => {
  assert.equal(inputAlignDbFor([], SR), 0)
  assert.equal(inputAlignDbFor([new Float32Array(0)], SR), 0)
  assert.equal(inputAlignDbFor([new Float32Array(SR)], SR), 0)      // digital silence
  assert.ok(Number.isFinite(inputAlignDbFor([new Float32Array(10).fill(0.5)], SR)))
})

test('a region shorter than one block still measures', () => {
  // Below one block there is no distribution to gate against; the fallback must
  // return a real level rather than 0 or NaN.
  const short = new Float32Array(Math.round(SR * ALIGN_BLOCK_MS / 1000) - 1).fill(0.25)
  const r = gatedRmsOfChannels([short], SR)
  assert.ok(Math.abs(db(r) - db(0.25)) < 1e-6)
})

test('the gate range is the fitted one', () => {
  // Pinned deliberately: 30 sits between two named failure modes (20 reads
  // noisy files hot, 40 lets a -40 dBFS tone back in). A change here is a
  // re-voicing of every plugin that aligns, so it should not pass silently.
  assert.equal(ALIGN_GATE_RANGE_DB, 30)
})


test('the manual trim range covers everything the measurement can produce', () => {
  // The Input knob DISPLAYS the measured offset (see useLA2A.js), so a range
  // narrower than the clamp would show a value the knob cannot represent.
  assert.ok(INPUT_TRIM_MAX_DB >= ALIGN_MAX_DB,
    `knob range ${INPUT_TRIM_MAX_DB} cannot show a measured ${ALIGN_MAX_DB}`)
})

test('the manual trim reaches past the automatic clamp, and that buys travel', () => {
  // The asymmetry is the point: past ~-39 dBFS peak the automatic offset
  // saturates and Peak Reduction starts running out again. A user who has
  // listened to the file can wind further than the guess is allowed to.
  assert.ok(INPUT_TRIM_MAX_DB > ALIGN_MAX_DB, 'the wider manual range is deliberate')

  const quiet = scaled(speech(4, -1), -44)   // ~-45 dBFS peak, past the clamp
  assert.equal(inputAlignDbFor([quiet], SR), ALIGN_MAX_DB, 'should be clamped')

  const atClamp = render(quiet, { peakReduction: 100, inputAlignDb: ALIGN_MAX_DB }).avgGr
  const atManual = render(quiet, { peakReduction: 100, inputAlignDb: INPUT_TRIM_MAX_DB }).avgGr
  assert.ok(atManual > atClamp + 3,
    `winding the trim past the clamp should recover real travel: ${atClamp} -> ${atManual}`)
})
