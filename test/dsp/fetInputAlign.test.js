/**
 * Run with:  npm test
 *
 * FET PUNCH SIDE-CHAIN ALIGNMENT — the offset that makes a knob position mean
 * the same thing on every file, on the unit whose Input knob is not a
 * side-chain control.
 *
 * ⚠ THE LOAD-BEARING PAIR IS `is exactly an input gain to the detector` AND
 * `is not an input gain to the audio path`. Both must hold, and neither alone
 * is the feature:
 *
 *   - The FIRST is what makes the alignment correct — the cell has to respond
 *     exactly as it would to a hotter file, or the offset is not measuring what
 *     it claims to.
 *   - The SECOND is what makes it safe, and it is the assertion that does not
 *     exist on OptoSmooth. There, side-chain drive is the ONLY thing Peak
 *     Reduction does, so the two properties are the same statement. Here the
 *     Input attenuator feeds the audio path as well, exactly as the hardware
 *     wires it, so an alignment folded into `inputDrive` would raise the output
 *     level by the same amount and push the FET saturator harder on a quiet
 *     file. That is the defect `inputAlignDb` exists to avoid, and it would
 *     leave every other test here passing.
 *
 * See `inputAlignDb` in `fet1176Processor.js` for the mechanism and
 * `dsp/inputAlign.js` for why alignment exists at all.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { processFET1176Buffer } from '../../src/audio/fet1176Processor.js'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'

const SR = 44100

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
const peakOf = (c) => { let m = 0; for (const v of c) m = Math.max(m, Math.abs(v)); return m }
const peakDb = (c) => 20 * Math.log10(peakOf(c))

/** Stock patch, minus the makeup — the makeup is not what is under test here. */
const PATCH = {
  inputDrive: 50, outputGainDb: 0, attack: 4, release: 4,
  ratio: '4', fetDrive: 0.35, scHpfHz: 0, mix: 1,
}

const render = (x, extra = {}) => processFET1176Buffer([x], SR, { ...PATCH, ...extra })

test('an absent offset, a zero offset and a null offset all render identically', () => {
  const x = speech(3, -6)
  const absent = render(x).channelData[0]
  const zero = render(x, { inputAlignDb: 0 }).channelData[0]
  /**
   * `null` is what `withMeasuredClears` pushes to turn the correction off on a
   * LIVE node — see effects/measuredKeys.js. The kernel merges a partial, so a
   * non-finite value has to mean "no alignment" rather than poisoning the
   * detector with NaN for the rest of the session.
   */
  const cleared = render(x, { inputAlignDb: null }).channelData[0]

  for (let i = 0; i < x.length; i++) {
    assert.equal(zero[i], absent[i], `zero differs at ${i}`)
    assert.equal(cleared[i], absent[i], `null differs at ${i}`)
  }
})

test('is exactly an input gain to the detector', () => {
  const x = speech(4, -24)
  // fetDrive 0 removes the one level-dependent stage, so the two renders are
  // comparable as DSP rather than only as gain reduction.
  for (const offsetDb of [3, 6, 12, 20, 30]) {
    const viaOffset = render(x, { fetDrive: 0, inputAlignDb: offsetDb }).metering
    const viaGain = render(scaled(x, offsetDb), { fetDrive: 0 }).metering
    // Measured agreement is ~5e-9 dB, i.e. float rounding on the two routes to
    // the same `levelDb`. 1e-6 is comfortably tight and not flaky.
    assert.ok(
      Math.abs(viaOffset.avgGainReductionDb - viaGain.avgGainReductionDb) < 1e-6,
      `+${offsetDb} dB: avg GR ${viaOffset.avgGainReductionDb} vs ${viaGain.avgGainReductionDb}`,
    )
    assert.ok(
      Math.abs(viaOffset.maxGainReductionDb - viaGain.maxGainReductionDb) < 1e-6,
      `+${offsetDb} dB: max GR ${viaOffset.maxGainReductionDb} vs ${viaGain.maxGainReductionDb}`,
    )
  }
})

test('is not an input gain to the audio path', () => {
  const x = speech(4, -24)
  const inputPeakDb = peakDb(x)

  for (const offsetDb of [12, 20]) {
    const viaOffset = render(x, { inputAlignDb: offsetDb }).channelData[0]
    const viaGain = render(scaled(x, offsetDb), {}).channelData[0]

    /**
     * The offset can only ever REDUCE: it drives the cell harder and touches
     * nothing else, so the output cannot come out above the source's peak.
     * Measured at +20 dB on this material: -32.42 dBFS out against -24.00 in.
     */
    assert.ok(
      peakDb(viaOffset) <= inputPeakDb + 1e-6,
      `+${offsetDb} dB offset raised the peak: ${peakDb(viaOffset)} > ${inputPeakDb}`,
    )

    /**
     * ⚠ AND THE INPUT-GAIN ROUTE DOES RAISE IT, WHICH IS THE POINT. Without
     * this half the test above would still pass on an implementation that
     * folded the offset into `inputDrive` and then quietly attenuated the
     * output to compensate — a different plugin, with the saturator driven from
     * the wrong place. Measured at +20 dB: -12.50 dBFS, 11.5 dB above the
     * source peak.
     */
    assert.ok(
      peakDb(viaGain) > inputPeakDb + 6,
      `+${offsetDb} dB input gain did not raise the peak as expected: ${peakDb(viaGain)}`,
    )
  }
})

test('makes a knob position deliver the same reduction at any file level', () => {
  const LEVELS = [-1, -6, -12, -18, -24, -30]

  for (const drive of [50, 70]) {
    const alignedGr = []
    const rawGr = []
    for (const peakDbfs of LEVELS) {
      const x = speech(6, peakDbfs)
      alignedGr.push(render(x, {
        inputDrive: drive, inputAlignDb: inputAlignDbFor([x], SR),
      }).metering.avgGainReductionDb)
      rawGr.push(render(x, { inputDrive: drive }).metering.avgGainReductionDb)
    }

    const spread = (a) => Math.max(...a) - Math.min(...a)

    /**
     * ⚠ THIS IS A PURE GAIN SWEEP, SO THE ALIGNMENT IS EXACT BY CONSTRUCTION —
     * measured spread is 0.00 dB and the tolerance below is for float noise,
     * not for the statistic. It proves the OFFSET IS APPLIED AND HAS THE RIGHT
     * SIGN AND SCALE; it says nothing about how gated RMS behaves on files that
     * differ in crest factor, noise floor or speech density, which is the
     * question `npm run fet:align` exists to answer against real narration.
     *
     * The unaligned figures are the defect being fixed: at Input 50 this
     * material delivers 7.35 dB at -1 dBFS and 0.00 dB at -18 and below.
     */
    assert.ok(spread(alignedGr) < 0.01,
      `Input ${drive}: aligned spread ${spread(alignedGr).toFixed(3)} dB — ${alignedGr}`)
    assert.ok(spread(rawGr) > 5,
      `Input ${drive}: unaligned spread ${spread(rawGr).toFixed(3)} dB is smaller than the`
      + ' defect this guards — has the patch or the stimulus changed?')
    // The quietest files must actually reach the operating point, not merely
    // agree with each other at zero.
    assert.ok(Math.min(...alignedGr) > 1,
      `Input ${drive}: aligned reduction ${Math.min(...alignedGr)} dB is not a working point`)
  }
})

test('a non-finite offset cannot poison the detector', () => {
  /**
   * Params reach this kernel over a message port from UI state, so one NaN is
   * always one bug away — and the detector's ballistics are persistent state,
   * so a NaN that enters them makes the plugin output NaN until the page is
   * reloaded. Measured exactly that way on the Scheps kernel; see the `finite`
   * guard there.
   */
  const x = speech(2, -6)
  for (const bad of [NaN, undefined, 'loud', Infinity]) {
    const out = render(x, { inputAlignDb: bad }).channelData[0]
    assert.ok(out.every(Number.isFinite), `offset ${String(bad)} produced non-finite output`)
  }
})
