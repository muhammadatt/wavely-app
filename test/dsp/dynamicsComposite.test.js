/**
 * Run with:  npm test
 *
 * VOCAL CHAIN — DYNAMICS SECTION. See src/audio/dynamicsProcessor.js and
 * docs/instant_polish_vocal_chain_spec.md.
 *
 * ⚠ THE LOAD-BEARING TESTS ARE THE TWO STRUCTURAL ONES: that the reported
 * latency is the sum of the three stages, and that Mix 0 is BIT-EXACT against
 * clip → FET alone. Everything else about this composite is tuning, which can
 * be argued about and re-measured; those two are either right or the whole
 * section is silently misaligned against the rest of the chain, and neither
 * failure is audible as a bug — it just sounds slightly wrong.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DynamicsKernel, processDynamicsBuffer, dynamicsPreRollSeconds,
  DYNAMICS_KERNEL_DEFAULTS,
  dynamicsLatencySamples, DYNAMICS_CLIP_LIMITER,
} from '../../src/audio/dynamicsProcessor.js'
import { processSoftClipperBuffer } from '../../src/audio/softClipperProcessor.js'
import { processFET1176Buffer } from '../../src/audio/fet1176Processor.js'
import { LA2A_PREROLL_S } from '../../src/audio/la2aProcessor.js'
import { fet1176PreRollSeconds } from '../../src/audio/fet1176Processor.js'

const SR = 44100

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
const peakDb = (c) => {
  let m = 0
  for (const v of c) m = Math.max(m, Math.abs(v))
  return 20 * Math.log10(m)
}

const CLIP_DB = -9
/** The clip and FET settings the composite pins, spelled out for the A/B below. */
/**
 * ⚠ `limiter` MIRRORS `DYNAMICS_CLIP_LIMITER` RATHER THAN BEING TYPED. This is
 * the reference the composite's head is compared against bit-for-bit, so a
 * literal here would not fail when the composite's balance moved — it would
 * fail because the reference no longer describes the composite, which reads as
 * a blend bug and is not one.
 */
const HEAD_CLIP = {
  limiter: DYNAMICS_CLIP_LIMITER, thresholdMode: 'fixed', fixedThresholdDb: CLIP_DB,
  outputTrimDb: 0, shape: 'tanh4',
}
const HEAD_FET = {
  inputDrive: 50, outputGainDb: 0, attack: 4, release: 4, ratio: '4',
  fetDrive: 0.35, scHpfHz: 80, mix: 1, inputAlignDb: 0,
}

test('latency is the sum of the three serial stages', () => {
  const k = new DynamicsKernel(SR)
  /**
   * 226 (clipper: the oversampler's 50 plus the limiter's 2 ms lookahead,
   * twice) + 50 (FET) + 50 (opto, lookahead pinned off).
   *
   * ⚠ DERIVED, NOT TYPED, because it is RATE-DEPENDENT — the lookahead is a
   * fixed number of milliseconds, so the section is 326 samples at 44.1 kHz and
   * 342 at 48. Every timeline caller takes `dynamicsLatencySamples` for that
   * reason; a constant is how the standalone shifted an applied region by 176
   * samples. See `DYNAMICS_CLIP_LIMITER`.
   */
  assert.equal(k.latencySamples, dynamicsLatencySamples(SR))
  assert.equal(k.latencySamples, 326)

  /**
   * ⚠ IT IS NOT THE SUM OF THE KERNELS' OWN GETTERS, AND THAT IDENTITY WAS ONLY
   * EVER INCIDENTALLY TRUE. Two things break it, both of them the reason the
   * composite derives its figure from the params instead:
   *
   *   - the clipper's getter returns `osLatency + (limiterActive ?
   *     limiterLatency : 0)`, and `limiterActive` is decided inside
   *     `process()` — so on a fresh kernel it reads 50 while the first block
   *     will delay by 226;
   *   - a BYPASSED stage never runs `process()` at all, so its getter stays at
   *     the constructor value forever while its delay line still carries the
   *     full latency. With no `clipThresholdDb` — the default — the clipper is
   *     bypassed, so the sum reads 150 against a composite that delays 326.
   *
   * Engaged and warmed, they agree. The property that actually matters is that
   * the DELAY matches the DECLARATION in every bypass combination, which the
   * impulse test measures rather than asserting a sum.
   */
  const engaged = new DynamicsKernel(SR)
  engaged.setParams({ clipThresholdDb: -6, fetDrive: 30, squash: 26 })
  engaged.process([new Float32Array(128)], [new Float32Array(128)], 128)
  assert.equal(
    engaged.latencySamples,
    engaged.clipper.latencySamples + engaged.fet.latencySamples + engaged.la2a.latencySamples,
  )
})

test('latency is CONSTANT across every patch a caller can set', () => {
  /**
   * ⚠ THE DRY DELAY AND THE APPLY PATH BOTH DEPEND ON THIS. The clipper's
   * limiter and the opto's lookahead each move their stage's latency when
   * enabled — 226 instead of 50, and up to 882 more — so both are pinned inside
   * the composite. A patch that could move either would misalign the blend and
   * splice the applied region late by the difference.
   */
  const base = new DynamicsKernel(SR).latencySamples
  for (const params of [
    { clipThresholdDb: null },
    { clipThresholdDb: -3, clipShape: 'tanh2' },
    { squash: 100, mix: 1 },
    { fetRatio: 'all', fetAttack: 7, fetRelease: 1 },
    { outputDb: 12, character: 'presence' },
    // Anything that tries to re-enable the pinned controls must be ignored.
    { limiter: 100, lookaheadMs: 20, thresholdMode: 'adaptive' },
  ]) {
    const k = new DynamicsKernel(SR)
    k.setParams(params)
    assert.equal(k.latencySamples, base,
      `latency moved to ${k.latencySamples} for ${JSON.stringify(params)}`)
  }
})

test('⚠ Mix 0 is BIT-EXACT against clip → FET alone', () => {
  /**
   * The blend is local to the opto block and its dry side is the POST-FET
   * signal, so Mix 0 must be the serial head and nothing else — no opto, no
   * Pultec, and no residue from either. It is a real voicing (fast and dry),
   * not a bypass, which is the point of putting the blend there rather than
   * around the whole section.
   *
   * ⚠ AND IT IS THE ONLY DIRECT CHECK ON THE DRY DELAY. The dry path is delayed
   * by exactly the opto's latency so the two arrive together; if that number
   * were wrong the blend would comb-filter at every other Mix, audibly, and
   * nothing else here would catch it.
   */
  const x = speech(4, -6)
  const composite = processDynamicsBuffer([x], SR, { mix: 0, clipThresholdDb: CLIP_DB })

  const clipped = processSoftClipperBuffer([x], SR, HEAD_CLIP).channelData
  const head = processFET1176Buffer(clipped, SR, HEAD_FET).channelData[0]

  const optoLatency = new DynamicsKernel(SR).la2a.latencySamples
  const got = composite.channelData[0]
  let worst = 0
  for (let i = 0; i < head.length - optoLatency; i++) {
    worst = Math.max(worst, Math.abs(got[i + optoLatency] - head[i]))
  }
  assert.equal(worst, 0, `Mix 0 is not the serial head: worst ${worst.toExponential(3)}`)
})

test('a null clip threshold bypasses the clipper rather than clipping at 0', () => {
  const x = speech(3, -6)
  const off = processDynamicsBuffer([x], SR, { mix: 0, clipThresholdDb: null })
  assert.equal(off.metering.clip.peak, 0)

  // And with one set, it does something.
  const on = processDynamicsBuffer([x], SR, { mix: 0, clipThresholdDb: -14 })
  assert.ok(on.metering.clip.peak > 0.5,
    `a -14 dBFS threshold on a -6 dBFS peak should clip; got ${on.metering.clip.peak}`)
})

test('⚠ nothing inside the section holds a peak ceiling', () => {
  /**
   * Peak control belongs to the chain's delivery solve, not here — this section
   * is mid-chain, with the tone section and the loudness solve after it, so a
   * ceiling in here would be undone downstream. Scheps needs one because its
   * kernel IS the last stage; carrying that over would also carry the knee cost
   * its own source records paying at low Mix.
   *
   * Asserted by behaviour rather than by reading params: drive the output trim
   * up and the output must go over full scale, because there is nothing in the
   * way.
   */
  const x = speech(2, -6)
  const hot = processDynamicsBuffer([x], SR, { mix: 0.35, clipThresholdDb: null, outputDb: 18 })
  assert.ok(peakDb(hot.channelData[0]) > 0,
    `expected the output over 0 dBFS with +18 dB of trim; got ${peakDb(hot.channelData[0]).toFixed(2)}`)
})

test('a non-finite param cannot poison the kernel', () => {
  /**
   * Params reach this kernel over a message port from UI state, so one NaN is
   * always one bug away — and it would enter the T4 cell's persistent envelope,
   * after which the composite outputs NaN until the page is reloaded. Measured
   * exactly that way on Scheps; see the `finite` guard in dsp/parallelMix.js.
   */
  const x = speech(1, -6)
  for (const bad of [NaN, undefined, Infinity, 'loud', null]) {
    for (const key of ['squash', 'mix', 'fetDrive', 'fetAlignDb', 'optoAlignDb', 'outputDb']) {
      const out = processDynamicsBuffer([x], SR, { [key]: bad }).channelData[0]
      assert.ok(out.every(Number.isFinite),
        `${key} = ${String(bad)} produced non-finite output`)
    }
  }
})

test('both channels move together — the detectors are shared', () => {
  /**
   * Each embedded compressor has one detector across the bus by design, so a
   * stereo file's two sides compress identically. Running them per channel
   * would let the sides drift apart, which on a dual-host podcast is an image
   * that wanders with whoever is louder.
   */
  const x = speech(3, -6)
  const stereo = processDynamicsBuffer([x, x], SR, { mix: 0.5, clipThresholdDb: CLIP_DB })
  const [l, r] = stereo.channelData
  for (let i = 0; i < l.length; i++) {
    assert.equal(l[i], r[i], `channels diverged at ${i}`)
  }
})

test('the pre-roll takes the slowest embedded envelope, which is the FET\'s', () => {
  /**
   * ⚠ NOT THE OPTO'S, THOUGH THIS SECTION IS "ABOUT" THE OPTO. `LA2A_PREROLL_S`
   * is 2 s and bit-exact; the FET's release tail runs to 6.6 s and its pre-roll
   * to 26.4. Taking the opto's number would under-roll the stage that actually
   * needs it.
   */
  assert.equal(dynamicsPreRollSeconds({}),
    Math.max(LA2A_PREROLL_S, fet1176PreRollSeconds({})))
  /**
   * At the slowest FET settings the FET still dominates — but by 8.7x, not the
   * order of magnitude this asserted when it was written.
   *
   * ⚠ THE BOUND MOVED BECAUSE THE FET'S TAIL DID, NOT BECAUSE THIS SECTION
   * CHANGED. `ALL_TAIL_FRACTION` went to 0 when the release was fitted to
   * FETish, so the all-buttons pre-roll this reads went 26.4 s to 17.49. The
   * claim under test is which stage sets the number, and that is unaffected.
   */
  const slow = dynamicsPreRollSeconds({ fetRelease: 1, fetRatio: 'all' })
  assert.ok(slow > LA2A_PREROLL_S * 8, `expected the FET to dominate; got ${slow}`)
  // At the fastest it still never drops below the opto's floor.
  assert.ok(dynamicsPreRollSeconds({ fetRelease: 7 }) >= LA2A_PREROLL_S)
})

test('⚠ each stage must be aligned at ITS OWN input, not at the section\'s', () => {
  /**
   * ⚠ THIS IS THE CONSEQUENCE OF CHAINING THAT THE SPEC DID NOT ANTICIPATE, and
   * it constrains how the solve has to work.
   *
   * Both compressors drive a fixed internal threshold, so each needs its input
   * aligned to nominal or its knob means nothing (see dsp/inputAlign.js). In a
   * SERIAL chain the stages do not share an input: the FET's Input attenuator
   * drops the audio path by ~1 dB at drive 50 and its own gain reduction takes
   * more, so by the time the signal reaches the opto it sits about 6 dB lower
   * in gated terms than the section's input did.
   *
   * Measured on narration at -6 dBFS peak, clip at -9: the section's input wants
   * an offset of -1.69 dB, the opto's own input wants +4.42. Aligning the opto
   * from the raw file gives it 0.25 dB of peak reduction; aligning it from its
   * own input gives 2.98 — twelve times more, from the same knob.
   *
   * So the solve cannot measure once at the front. It has to render the head
   * stage by stage and measure where each stage actually sits.
   *
   * ⚠ SQUASH IS PINNED AT 40 HERE, which was the kernel default when these
   * figures were measured; the shipping default has since been recalibrated to
   * 33 on real narration. The finding is about where the alignment is taken,
   * not how deep the layer is, so the depth is held fixed rather than tracking
   * a default that can move.
   */
  const x = speech(6, -6)
  const fromSectionInput = processDynamicsBuffer([x], SR, {
    mix: 1, clipThresholdDb: CLIP_DB, squash: 40, fetAlignDb: -1.69, optoAlignDb: -1.69,
  })
  const fromOwnInput = processDynamicsBuffer([x], SR, {
    mix: 1, clipThresholdDb: CLIP_DB, squash: 40, fetAlignDb: -1.12, optoAlignDb: 4.42,
  })

  /**
   * ⚠ 0.6 -> 0.9 WHEN THE RATIO-DEPENDENT THRESHOLD SHIPPED. The FET now moves
   * its threshold with the ratio button, so it hands the opto a slightly
   * different level and the section-aligned case reads 0.71 dB where it read
   * under 0.6. The contrast the test exists for is untouched: the opto's own
   * input still wakes it four times harder from the same knob.
   */
  assert.ok(fromSectionInput.metering.opto.peak < 0.9,
    `aligning from the section input should leave the opto idle; got `
    + `${fromSectionInput.metering.opto.peak.toFixed(2)} dB`)
  assert.ok(fromOwnInput.metering.opto.peak > 2,
    `aligning from the opto's own input should wake it; got `
    + `${fromOwnInput.metering.opto.peak.toFixed(2)} dB`)
  assert.ok(fromOwnInput.metering.opto.peak > fromSectionInput.metering.opto.peak * 4,
    'the gap between the two is the whole finding')
})

test('the defaults name every param the kernel reads', () => {
  // A param the kernel reads but the defaults omit is one a caller can never
  // clear back to a known state, and one a test can never see move.
  const k = new DynamicsKernel(SR)
  assert.deepEqual(
    Object.keys(k.params).sort(), Object.keys(DYNAMICS_KERNEL_DEFAULTS).sort(),
  )
  // The measured keys are absent-by-default, not zero-by-default, where zero
  // would be a real setting rather than "unmeasured".
  assert.equal(DYNAMICS_KERNEL_DEFAULTS.clipThresholdDb, null)
})

test('⚠ an UN-SOLVED section is bit-exact pass-through, not a default patch', () => {
  /**
   * This is what lets the panel open ENGAGED rather than bypassed.
   *
   * A live node with no solve in force clears every measured key to null (see
   * DYNAMICS_MEASURED_KEYS). Only the clipper treated that as "bypass"; the FET
   * and the opto fell back to their kernel defaults — `fetDrive: 50`,
   * `squash: 33` — with both alignments at 0, so an engaged-but-un-solved
   * section was an UNMEASURED compressor doing real work while the panel said
   * "Solve first". On a −1 dBFS file that is roughly 7 dB of gain reduction
   * nobody asked for, and it is exactly the failure `effects/measuredKeys.js`
   * documents one level up.
   */
  const n = 20000
  const x = new Float32Array(n)
  let s = 7
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 2 - 1
  for (let i = 0; i < n; i++) x[i] = Math.fround(rnd() * 0.4)

  const r = processDynamicsBuffer([x], SR, {
    clipThresholdDb: null, fetDrive: null, squash: null,
  })
  const out = r.channelData[0]
  assert.equal(r.latencySamples, dynamicsLatencySamples(SR))
  for (let i = 0; i < n - r.latencySamples; i++) {
    assert.equal(out[i + r.latencySamples], x[i],
      `un-solved must be bit-exact pass-through; diverged at ${i}`)
  }
  // Mix and the blend law must not reach a bypassed opto block either.
  const wet = processDynamicsBuffer([x], SR, {
    clipThresholdDb: null, fetDrive: null, squash: null, mix: 1, correlation: 0.9,
  })
  assert.deepEqual(wet.channelData[0], out, 'Mix moved a section that is bypassed')
})

test('⚠ latency is constant in FACT, not just in what the getter DECLARES', () => {
  /**
   * ⚠ THE TEST ABOVE ("CONSTANT ACROSS EVERY PATCH") DID NOT CATCH THIS, and
   * that is the reusable part. It asserts `latencySamples` — the DECLARED
   * number — which was never wrong. What moved was the delay actually applied:
   * the clipper's bypass skipped its processing, so with no threshold the
   * composite delayed by 100 samples while still declaring 150, and
   * `applyWorkletRegion` trimmed 50 samples too many off the front of the
   * region. It bit below Density ~2.5, where the wanted shave rounds to nothing
   * and the threshold stays null.
   *
   * Measuring an impulse is the only way to see it, so this does that.
   */
  const n = 4096
  const impulseAt = 1000
  const peakIndex = (params) => {
    const x = new Float32Array(n)
    x[impulseAt] = 0.5
    const out = processDynamicsBuffer([x], SR, params).channelData[0]
    let best = 0
    let at = -1
    for (let i = 0; i < n; i++) {
      const a = Math.abs(out[i])
      if (a > best) { best = a; at = i }
    }
    return at
  }
  const expected = impulseAt + dynamicsLatencySamples(SR)
  assert.equal(peakIndex({ clipThresholdDb: -6, mix: 0 }), expected, 'all stages engaged')
  assert.equal(peakIndex({ clipThresholdDb: null, mix: 0 }), expected, 'clipper bypassed')
  assert.equal(peakIndex({ clipThresholdDb: null, fetDrive: null }), expected, 'FET bypassed')
  assert.equal(peakIndex({ clipThresholdDb: null, fetDrive: null, squash: null }), expected,
    'nothing solved')
})
