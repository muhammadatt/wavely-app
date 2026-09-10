/**
 * OptoSmooth's imported Tube Saturation curve — the two selectors, and the
 * guarantee that neither of them exists as far as the default patch is
 * concerned.
 *
 * ⚠ THE BIT-IDENTITY TEST IS THE POINT OF THIS FILE. Everything else here
 * describes a stage chosen by ear, and taste is not what a test pins. What a
 * test CAN pin is that a render made before this stage existed is the same
 * render after it — every preset, every saved patch, every file already on
 * disk. That is what makes the option safe to ship, and it is asserted on the
 * oversampled path AND the base-rate measurement path, because the makeup
 * solver runs on the second one and a divergence there would move the makeup
 * without moving the audio.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  LA2AKernel, processLA2ABuffer,
  TUBE_CURVE_TANH, TUBE_CURVE_VOCALSAT,
  CELL_CURVE_GAINMOD, CELL_CURVE_VOCALSAT,
} from '../../src/audio/la2aProcessor.js'
import { LA2A_KERNEL_DEFAULTS } from '../../src/audio/la2aProcessor.js'
import { makeVocalSatCurve } from '../../src/audio/dsp/vocalSatCurve.js'

/**
 * The pre-import kernel, as a patch.
 *
 * ⚠ THIS IS NOT "THE DEFAULTS" ANY MORE. Tube Saturation's curve ships at both
 * stages now, so the old model has to be asked for by name — and it must stay
 * exactly reachable, because every render, preset and rendered file made before
 * the switch was made with it.
 */
const LEGACY = {
  tubeCurve: TUBE_CURVE_TANH,
  cellCurve: CELL_CURVE_GAINMOD,
  emphasis: 0,
}

const SR = 44100

/** Narration-ish: a harmonic stack under a syllabic envelope, with pauses. */
function speech(seconds = 1.5, peak = 0.35) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let s = 0
    for (let k = 1; k <= 24; k++) {
      s += (1 / k) * Math.sin(2 * Math.PI * 118 * k * t + k * 1.7)
    }
    const syl = Math.pow(Math.max(0, Math.sin(2 * Math.PI * 4 * t)), 0.6)
    x[i] = s * syl * ((t % 0.55) > 0.42 ? 0.02 : 1)
  }
  let m = 0
  for (const v of x) m = Math.max(m, Math.abs(v))
  for (let i = 0; i < n; i++) x[i] = (x[i] / m) * peak
  return x
}

const run = (params) => processLA2ABuffer(
  [Float32Array.from(speech())], SR,
  { peakReduction: 70, gainDb: 3, inputAlignDb: 12, ...params },
).channelData[0]

test('the shipping patch is the audition patch, exactly', () => {
  // Pins what OptoSmooth and Scheps sound like out of the box. Every one of
  // these was chosen by ear; if a refactor moves one, that is a change to the
  // product's sound and it should have to come through this test.
  const d = LA2A_KERNEL_DEFAULTS
  assert.equal(d.tubeCurve, TUBE_CURVE_VOCALSAT)
  assert.equal(d.cellCurve, CELL_CURVE_VOCALSAT)
  assert.equal(d.cellCurveDriveMax, 1.5)
  assert.equal(d.vocalSatCurveDrive, 0.5)
  assert.equal(d.vocalSatLeanPositive, true)
  assert.equal(d.emphasis, 100)
  assert.equal(d.tube, true)
})

test('the pre-import kernel is still exactly reachable by name', () => {
  // Everything rendered before the switch was made with this. It must not
  // become approximately recoverable.
  const legacy = run(LEGACY)
  const explicit = run({
    ...LEGACY, cellMod: 1, cellCurveDriveMax: 1.5, vocalSatCurveDrive: 0.5,
  })
  // The imported-curve knobs must not reach the legacy path at all.
  assert.deepEqual(Array.from(explicit), Array.from(legacy))
})

test('the legacy path holds on the base-rate path the makeup solver uses', () => {
  const a = run({ ...LEGACY, oversample: false })
  const b = run({
    ...LEGACY, oversample: false, cellCurveDriveMax: 99, vocalSatCurveDrive: 8,
  })
  assert.deepEqual(Array.from(b), Array.from(a))
})

test('an unknown curve name falls back to what SHIPS, not to the old model', () => {
  // It fell back to tanh/gainmod while those were the defaults. Left alone,
  // a typo or a stale param message would silently select the previous model.
  const base = run({})
  assert.deepEqual(Array.from(run({ tubeCurve: 'nope', cellCurve: 'nope' })),
    Array.from(base))
  assert.deepEqual(Array.from(run({ tubeCurve: undefined, cellCurve: undefined })),
    Array.from(base))
})

test('each selector actually changes the output', () => {
  const base = run({})
  assert.notDeepEqual(Array.from(run({ tubeCurve: TUBE_CURVE_TANH })),
    Array.from(base))
  assert.notDeepEqual(Array.from(run({ cellCurve: CELL_CURVE_GAINMOD })),
    Array.from(base))
})

test('the cell shaper replaces the gain modulation rather than stacking with it', () => {
  // With the shaper selected, `cellMod` is inert — the modulation is not
  // running, so its depth control has nothing to scale.
  const a = run({ cellCurve: CELL_CURVE_VOCALSAT })
  const b = run({ cellCurve: CELL_CURVE_VOCALSAT, cellMod: 0 })
  assert.deepEqual(Array.from(a), Array.from(b))
})

test('the cell shaper is absent at zero gain reduction, as the cell must be', () => {
  // Against `cellMod: 0` — the comparison is "no cell distortion of either
  // kind", not the default patch, because selecting the shaper switches the
  // gain modulation off and differencing against the default would measure
  // that removal instead. That mistake is why this test failed first time.
  const quiet = { peakReduction: 0, gainDb: 0, inputAlignDb: 0 }
  const base = run({ ...quiet, cellCurve: CELL_CURVE_GAINMOD, cellMod: 0 })
  const shaped = run({ ...quiet, cellCurve: CELL_CURVE_VOCALSAT })
  // The bound is the ramp-restructure floor pinned by the next test, not a
  // tolerance on the curve: at zero reduction the drive is exactly zero and
  // `transferAt` is the identity, so nothing of the curve is present at all.
  let err = 0
  let sig = 0
  for (let i = 0; i < base.length; i++) {
    err += (base[i] - shaped[i]) ** 2
    sig += base[i] ** 2
  }
  const dbc = 10 * Math.log10(err / sig)
  assert.ok(dbc < -90, `no cell distortion at 0 GR (${dbc.toFixed(1)} dBc)`)
})

/**
 * ⚠ THE SHAPER PATH IS NOT BIT-IDENTICAL TO THE DEFAULT ONE EVEN WITH THE
 * CURVE REMOVED, AND THIS PINS HOW FAR OFF IT IS.
 *
 * The default loop interpolates ONE gain across the oversampled sub-samples;
 * the shaper loop has to interpolate the attenuation and the makeup separately,
 * because the curve sits between them. A linear ramp of a product is not the
 * product of two linear ramps, so the two differ by a second-order term.
 *
 * Measured at -100.7 dBc on programme material at Peak Reduction 70 — three
 * orders below the -70 dB bar the curve modules hold themselves to, and far
 * under the plugin's own alias floor. It is not zero, it is not audible, and
 * nobody should discover it by differencing renders and wondering.
 */
test('splitting the gain ramp in two costs less than -90 dBc', () => {
  const noCell = run({ cellCurve: CELL_CURVE_GAINMOD, cellMod: 0 })
  // Shaper selected, drive floored: isolates the ramp restructure alone.
  const ramped = run({ cellCurve: CELL_CURVE_VOCALSAT, cellCurveDriveMax: 1e-12 })
  let err = 0
  let sig = 0
  for (let i = 0; i < noCell.length; i++) {
    err += (noCell[i] - ramped[i]) ** 2
    sig += noCell[i] ** 2
  }
  const dbc = 10 * Math.log10(err / sig)
  assert.ok(dbc < -90, `ramp restructure residual ${dbc.toFixed(1)} dBc`)
})

test('latency does not move — neither curve resamples or looks ahead', () => {
  const base = processLA2ABuffer([speech(0.2)], SR, {})
  const both = processLA2ABuffer([speech(0.2)], SR, {
    tubeCurve: TUBE_CURVE_VOCALSAT, cellCurve: CELL_CURVE_VOCALSAT,
  })
  assert.equal(both.latencySamples, base.latencySamples)
})

test('the imported curve is Tube Saturation\'s own, not a copy that can drift', () => {
  // If `vocalSatParams.js` retunes, this follows. The assertion is that the
  // kernel's curve and a freshly built one from the shared module agree.
  // Built at the KERNEL's configured drive, not the module's own fallback —
  // the two diverged when the valve's shipping drive became an auditioned 0.5
  // rather than the 2.38 reconstruction, and this test caught it.
  const curve = makeVocalSatCurve({
    curveDrive: LA2A_KERNEL_DEFAULTS.vocalSatCurveDrive,
    leanPositive: LA2A_KERNEL_DEFAULTS.vocalSatLeanPositive,
  })
  const k = new LA2AKernel(SR)
  k.setParams({ tubeCurve: TUBE_CURVE_VOCALSAT })
  for (const x of [-0.9, -0.3, -0.01, 0, 0.01, 0.3, 0.9]) {
    assert.equal(k.shapeTube(x), curve.transfer(x))
  }
})

test('the curve inverse round-trips on BOTH branches, not just the positive one', () => {
  // SPLIT asymmetry makes the curve non-odd; an inverse that folds through
  // Math.abs answers the wrong half. Guards the bug that shipped in the first
  // draft of this module.
  const { transfer, inverse } = makeVocalSatCurve()
  for (let x = -4; x <= 4; x += 0.037) {
    assert.ok(Math.abs(inverse(transfer(x)) - x) < 1e-9, `round trip at ${x}`)
  }
})

test('auto makeup still solves with the imported tube curve', () => {
  const src = speech(2)
  const k = new LA2AKernel(SR)
  k.setParams({ peakReduction: 70, inputAlignDb: 12, tubeCurve: TUBE_CURVE_VOCALSAT })
  const out = new Float32Array(128)
  for (let off = 0; off + 128 <= src.length; off += 128) {
    k.process([src.subarray(off, off + 128)], [out], 128)
  }
  const db = k.liveAutoMakeupDb()
  assert.ok(db !== null, 'the tracker reports a makeup')
  assert.ok(Number.isFinite(db) && db > -60 && db < 60, `makeup in range: ${db}`)
})

// ── The emphasis pair ──────────────────────────────────────────────────────

test('emphasis 0 removes the pair entirely rather than running it flat', () => {
  // The branch is skipped and the filter state never advances, so the legacy
  // patch is the kernel that predates the pair — not a shelf set to 0 dB.
  const off = run(LEGACY)
  assert.deepEqual(Array.from(run({ ...LEGACY, emphasis: 0 })), Array.from(off))
  assert.notDeepEqual(Array.from(run({ ...LEGACY, emphasis: 100 })),
    Array.from(off))
})

test('the pair does not reach the side-chain', () => {
  // If it did, the shelf would change the ballistics and what a Peak Reduction
  // setting means — the pair is only allowed to change what the nonlinearities
  // do with the audio.
  const a = processLA2ABuffer([Float32Array.from(speech())], SR,
    { peakReduction: 70, inputAlignDb: 12, emphasis: 0 })
  const b = processLA2ABuffer([Float32Array.from(speech())], SR,
    { peakReduction: 70, inputAlignDb: 12, emphasis: 100 })
  assert.equal(a.metering.avgGainReductionDb, b.metering.avgGainReductionDb)
  assert.equal(a.metering.maxGainReductionDb, b.metering.maxGainReductionDb)
})

test('the pair does not reach the dry path — bypass stays the input', () => {
  // `mix: 0` is the bypass reference. Pre-emphasising in place over `input`
  // instead of into scratch would make it a shelved copy of itself.
  const dry0 = run({ mix: 0, emphasis: 0 })
  const dry1 = run({ mix: 0, emphasis: 100 })
  /**
   * ⚠ `===` RATHER THAN `deepEqual`, FOR SIGNED ZERO. The emphasis branch sums
   * the mix in a different order, and on one sample of this probe that yields
   * -0 where the default path yields +0. `deepEqual` compares with SameValue
   * and calls that a difference; every arithmetic consumer treats them as
   * equal, and there is no bit pattern here that reaches audio. Asserted this
   * way deliberately rather than by loosening to a tolerance, which would also
   * have hidden a real one-sample error.
   */
  for (let i = 0; i < dry0.length; i++) {
    assert.ok(dry1[i] === dry0[i], `dry path unchanged at sample ${i}`)
  }
})

test('emphasis is applied before the ceiling, not after it', () => {
  // A shelf downstream of the ceiling can put back what the ceiling took off,
  // which would break the "never louder than the source" guarantee the
  // percentile-referenced makeup depends on.
  const ceilingDb = -12
  const out = run({ emphasis: 100, ceilingDb })
  let peak = 0
  for (const v of out) peak = Math.max(peak, Math.abs(v))
  const peakDb = 20 * Math.log10(peak)
  assert.ok(peakDb <= ceilingDb + 0.01, `peak ${peakDb.toFixed(2)} under ceiling`)
})

test('the pair absorbs on the imported cell shaper and is inert on tanh', () => {
  // Pins the table in the EMPHASIS_MAX_DB note: the direction of each result,
  // not its exact value. If a future change makes the pair work on tanh, that
  // is a finding and this test is where it surfaces.
  const crest = (a) => {
    let p = 0
    let s = 0
    for (let i = 4096; i < a.length; i++) {
      p = Math.max(p, Math.abs(a[i]))
      s += a[i] * a[i]
    }
    return 20 * Math.log10(p / Math.sqrt(s / (a.length - 4096)))
  }
  const shaper = { cellCurve: CELL_CURVE_VOCALSAT, cellCurveDriveMax: 12 }
  const shaperDelta = crest(run({ ...shaper, emphasis: 50 }))
    - crest(run({ ...shaper, emphasis: 0 }))
  const valveOnly = { ...LEGACY, cellMod: 0 }
  const tanhDelta = crest(run({ ...valveOnly, emphasis: 50 }))
    - crest(run({ ...valveOnly, emphasis: 0 }))
  assert.ok(shaperDelta < -0.2, `shaper absorbs (${shaperDelta.toFixed(2)} dB)`)
  assert.ok(Math.abs(tanhDelta) < 0.1, `tanh valve inert (${tanhDelta.toFixed(2)} dB)`)
})

// ── Live re-enable, which the bench panel does to a running worklet ─────────

/**
 * ⚠ BOTH OF THESE WERE REAL AND BOTH CAME FROM A REVIEW, NOT FROM THIS SUITE.
 * The tuning panel writes params onto a worklet that is already streaming, so
 * "switch it off and back on mid-playback" is an ordinary user action. Neither
 * stage cleaned up after itself on the way out.
 */
test('disabling the emphasis pair empties its filters', () => {
  /**
   * ⚠ ASSERTS THE STATE, NOT THE SIGNAL, AND THE FIRST VERSION OF THIS TEST
   * WAS VACUOUS FOR EXACTLY THAT REASON. It compared a toggled kernel against
   * a fresh one and required the block after re-enable to agree within 40 dBc
   * — which it does with the fix REMOVED, because the two kernels differ
   * legitimately in detector and cell history and that swamps the filter
   * memory. A 1800 Hz biquad also forgets in well under a millisecond, so the
   * signal-level evidence is small and easily masked. The claim worth pinning
   * is the invariant: while the pair is off, it holds nothing.
   */
  const x = speech()
  const k = new LA2AKernel(SR)
  k.setParams({ peakReduction: 70, gainDb: 3, inputAlignDb: 12, emphasis: 100 })
  const out = new Float32Array(128)
  for (let off = 0; off + 128 <= 8192; off += 128) {
    k.process([x.subarray(off, off + 128)], [out], 128)
  }
  const live = [...k.preEmph, ...k.deEmph, ...k.trkEmph]
  assert.ok(live.length > 0, 'the filters were built')
  assert.ok(live.some(f => f.z1.some(v => v !== 0) || f.z2.some(v => v !== 0)),
    'precondition: the filters hold state while the pair is running')

  k.setParams({ emphasis: 0 })
  for (const f of [...k.preEmph, ...k.deEmph, ...k.trkEmph]) {
    assert.ok(f.z1.every(v => v === 0) && f.z2.every(v => v === 0),
      'a bypassed emphasis filter is still holding pre-bypass audio')
  }
})

test('toggling the cell shaper resets its ramp seams to the stage\'s identities', () => {
  /**
   * Same reasoning: the seams only advance while the shaper runs, so after a
   * spell switched off they name gains and a drive from whenever it last ran.
   * Re-enabling then ramps the first block FROM those, which is a step. The
   * identities are unity gains and a zero drive — `transferAt` reads that as
   * the stage being absent, so the first block ramps in from nothing exactly
   * as a fresh kernel does.
   */
  const x = speech()
  const k = new LA2AKernel(SR)
  k.setParams({
    peakReduction: 70, gainDb: 3, inputAlignDb: 12,
    cellCurve: CELL_CURVE_VOCALSAT,
  })
  const out = new Float32Array(128)
  for (let off = 0; off + 128 <= 8192; off += 128) {
    k.process([x.subarray(off, off + 128)], [out], 128)
  }
  assert.ok(k.seamDrive > 0, 'precondition: the seams advanced while running')

  k.setParams({ cellCurve: CELL_CURVE_GAINMOD })
  assert.equal(k.seamPreG, 1)
  assert.equal(k.seamMakeup, 1)
  assert.equal(k.seamDrive, 0)
})
