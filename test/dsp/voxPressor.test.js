/**
 * Run with:  npm test
 *
 * VoxPressor stage 1 — the voice detector and the Peaks (1176) → Body (LA-2A)
 * core. Pins what the plugin adds beyond the two kernels it holds: the
 * sidechain hook that feeds them the detector, the bypasses that keep the
 * latency constant, the detector's shape, and the per-file solves that give
 * Peaks and Body their meaning.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narration } from '../helpers/narration.js'
import { LA2AKernel } from '../../src/audio/la2aProcessor.js'
import { FET1176Kernel } from '../../src/audio/fet1176Processor.js'
import {
  processVoxPressorBuffer, VOX_KERNEL_DEFAULTS, peaksTap, BODY_TAP, voxLatencySamples, PEAKS_INPUT_KNOB, VoxPressorKernel,
  peaksTiming, PEAKS_SPEEDS,
} from '../../src/audio/voxPressorProcessor.js'
import { LinkedPeakLimiter } from '../../src/audio/dsp/peakLimiter.js'
import { releaseSecondsForDial } from '../../src/audio/fet1176Processor.js'
import {
  voiceDetectorSections, PLOSIVE_SHELF_DB, SIBILANCE_SHELF_DB,
} from '../../src/audio/dsp/voiceDetector.js'
import {
  measureVoxPressor, PEAKS_BODY_WARN_DB, measureVoxPressorExact,
} from '../../src/audio/voxPressorSolve.js'
import { magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'
import { gatedRmsOfChannels, inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import {
  toKernelParams, VOX_DEFAULTS, peaksDriveDb, PEAKS_DRIVE_PER_STEP_DB, VOX_MEASURED_KEYS,
} from '../../src/audio/effects/voxPressorParams.js'

const SR = 44100
const db = v => 20 * Math.log10(v)

function peak(x) {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

function runKernel(kernel, x, sidechain) {
  const out = new Float32Array(x.length)
  for (let o = 0; o < x.length; o += 128) {
    const n = Math.min(128, x.length - o)
    kernel.process([x.subarray(o, o + n)], [out.subarray(o, o + n)], n,
      sidechain ? sidechain.subarray(o, o + n) : undefined)
  }
  return out
}

const speech = narration(SR, { seconds: 12, levelDb: -24 })

test('LA-2A: a sidechain equal to its own mono tap renders bit-identically', () => {
  const a = new LA2AKernel(SR)
  const b = new LA2AKernel(SR)
  a.setParams({ inputAlignDb: 8 })
  b.setParams({ inputAlignDb: 8 })
  const plain = runKernel(a, speech)
  const fed = runKernel(b, speech, speech)
  assert.deepEqual(fed, plain)
})

test('1176: a sidechain equal to its own mono tap renders bit-identically', () => {
  const a = new FET1176Kernel(SR)
  const b = new FET1176Kernel(SR)
  a.setParams({ ratio: '12', inputAlignDb: 6 })
  b.setParams({ ratio: '12', inputAlignDb: 6 })
  const plain = runKernel(a, speech)
  const fed = runKernel(b, speech, speech)
  assert.deepEqual(fed, plain)
})

test('a sidechain moves the gain, never the audio path', () => {
  // A silent detector means no reduction: the LA-2A then renders exactly what
  // it renders on input too quiet to reach its threshold.
  const quiet = new LA2AKernel(SR)
  quiet.setParams({ inputAlignDb: -60 })
  const silentSc = new LA2AKernel(SR)
  silentSc.setParams({ inputAlignDb: 8 })
  const ref = runKernel(quiet, speech)
  const out = runKernel(silentSc, speech, new Float32Array(speech.length))
  assert.deepEqual(out, ref)
})

test('both stages off is a pure delay of the constant latency, bit for bit', () => {
  const { channelData, latencySamples } = processVoxPressorBuffer([speech], SR, {
    peaksOn: false, bodyOn: false,
  })
  assert.equal(latencySamples, voxLatencySamples({}, SR))
  const y = channelData[0]
  for (let i = latencySamples; i < y.length; i++) {
    if (y[i] !== speech[i - latencySamples]) assert.fail(`sample ${i} differs`)
  }
})

test('the latency does not move when a stage is switched', () => {
  const lat = (p) => processVoxPressorBuffer([speech.subarray(0, 4096)], SR, p).latencySamples
  const all = lat({})
  assert.equal(lat({ peaksOn: false }), all)
  assert.equal(lat({ bodyOn: false }), all)
  assert.equal(lat({ peaksOn: false, bodyOn: false }), all)
})

test('voxLatencySamples matches the kernel, Body lookahead included', () => {
  for (const lookaheadMs of [0, 5, 20]) {
    for (const oversample of [true, false]) {
      const p = { bodyBench: { lookaheadMs }, oversample }
      const { latencySamples } = processVoxPressorBuffer([speech.subarray(0, 256)], SR, p)
      assert.equal(voxLatencySamples(p, SR), latencySamples, `${lookaheadMs} ms, oversample ${oversample}`)
      // And it does not move when the Body stage is switched off.
      const off = processVoxPressorBuffer([speech.subarray(0, 256)], SR, { ...p, bodyOn: false })
      assert.equal(off.latencySamples, latencySamples)
    }
  }
})

test('the stage limiter holds its ceiling with a GAIN, never reshaping a sample', () => {
  // A voice with transient spikes far over the ceiling: every output sample
  // must be the delayed input times one gain in (0, 1], the gain may move only
  // as fast as the smoother allows, and nothing may cross the ceiling.
  const x = narration(SR, { seconds: 4, levelDb: -20 }).slice()
  for (let k = 1; k < 8; k++) x[k * 20000] = k % 2 ? 0.95 : -0.95
  const T = 0.25 // exact in float32, so the bound is the stored one
  const lim = new LinkedPeakLimiter(SR)
  lim.setThreshold(T)
  const io = [x.slice()]
  lim.process(io, x.length)
  const y = io[0]
  const L = lim.latencySamples
  // A clipper also scales each sample by something in (0, 1]; what only a gain
  // envelope does is move SLOWLY: two cascaded boxcars of length L/2 + 1 on
  // values in [0, 1] change by at most 1 / (L/2 + 1) a sample.
  const maxStep = 1 / (lim.L + 1) + 1e-5
  let caught = 0
  let prev = null
  for (let i = L; i < x.length; i++) {
    assert.ok(Math.abs(y[i]) <= T, `sample ${i} over the ceiling: ${y[i]}`)
    const xi = x[i - L]
    if (Math.abs(xi) < 1e-3) { prev = null; continue }
    const g = y[i] / xi
    assert.ok(g > 0 && g <= 1 + 1e-6, `sample ${i}: gain ${g}`)
    if (prev !== null) assert.ok(Math.abs(g - prev) <= maxStep, `sample ${i}: gain stepped ${g - prev}`)
    if (g < 0.999) caught++
    prev = g
  }
  assert.ok(caught > 0)
  // With no ceiling it is a pure delay, bit for bit.
  const idle = new LinkedPeakLimiter(SR)
  const io2 = [x.slice()]
  idle.process(io2, x.length)
  for (let i = L; i < x.length; i++) {
    if (io2[0][i] !== x[i - L]) assert.fail(`idle sample ${i} differs`)
  }
})

test('stereo: an identical pair renders identically on both sides', () => {
  const x = speech.subarray(0, SR * 3)
  const { channelData } = processVoxPressorBuffer([x, x.slice()], SR, { peaksAlignDb: -6, bodyAlignDb: 8 })
  assert.deepEqual(channelData[1], channelData[0])
})

test('detector shape: the Body tap ducks plosives and sibilance, the Peaks tap neither', () => {
  const body = voiceDetectorSections(SR, { cornerHz: 70, ...BODY_TAP })
  const peaks = voiceDetectorSections(SR, { cornerHz: 70, ...peaksTap(VOX_KERNEL_DEFAULTS.peaksSibilance) })
  const f = [40, 100, 1000, 12000]
  const b = magnitudeResponseDb(body, f, SR)
  const p = magnitudeResponseDb(peaks, f, SR)
  // Below the corner: rolled off on both.
  assert.ok(b[0] < -6 && p[0] < -6)
  // A plosive's band: the Body tap sits well under the Peaks tap.
  assert.ok(p[1] - b[1] > 6, `100 Hz: peaks ${p[1].toFixed(2)} vs body ${b[1].toFixed(2)}`)
  assert.ok(p[1] > -3, 'the Peaks tap keeps a plosive audible to the 1176')
  // Vowels: untouched on both.
  assert.ok(Math.abs(b[2]) < 1 && Math.abs(p[2]) < 1)
  // Sibilance: the full shelf on Body; the 1176 hears it, so it can trim it.
  assert.ok(Math.abs(b[3] - SIBILANCE_SHELF_DB) < 1)
  assert.ok(Math.abs(p[3]) < 1, `12 kHz on the Peaks tap: ${p[3].toFixed(2)} dB`)
  assert.ok(PLOSIVE_SHELF_DB < 0)
})

/**
 * Six words, each opened by a "p": a 120 ms puff of low-passed noise (two
 * one-poles at 250 Hz), the broadband wind a plosive puts on a mic.
 */
function puffedPhrase(puffs, amp = 6) {
  let s = 7
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  const n = 4 * SR
  const x = new Float32Array(n)
  const c = 1 - Math.exp(-2 * Math.PI * 250 / SR)
  for (let w = 0; w < 6; w++) {
    const st = Math.round((0.5 + w * 0.6) * SR)
    for (let i = 0; i < 0.45 * SR; i++) {
      const t = i / SR
      let v = 0
      for (let k = 1; k <= 30; k++) {
        const f = k * 120
        v += Math.sin(2 * Math.PI * f * t + k) / (1 + ((f - 600) / 400) ** 2)
      }
      x[st + i] = 0.05 * v * Math.min(1, t / 0.02) * Math.exp(-2 * t)
    }
    let lp1 = 0
    let lp2 = 0
    for (let i = 0; i < 0.12 * SR; i++) {
      // Drawn whether or not it is rendered, so both variants share the voice.
      lp1 += (rnd() * 2 - 1 - lp1) * c
      lp2 += (lp1 - lp2) * c
      if (puffs) x[st - Math.round(0.03 * SR) + i] += amp * 0.4 * lp2 * Math.exp(-(i / SR) / 0.04)
    }
  }
  return x
}

test('plosives push the Body stage less than they push a plain LA-2A', () => {
  // ⚠ A MODEST CLAIM, AND THAT IS THE MEASUREMENT. The LA-2A kernel already
  // high-passes its own side-chain at 80 Hz and its detector is slow, so on
  // synthetic plosives even the plain compressor gains well under 1 dB of
  // average reduction from them (0.65 here, at 18 dB of drive offset). The
  // detector's shelf takes a third or more of that away. Whether real
  // plosives are worse than synthetic ones is for real recordings to say.
  const avg = (g) => g.reduce((a, b) => a + b, 0) / g.length
  const vox = x => avg(processVoxPressorBuffer([x], SR, {
    peaksOn: false, bodyAlignDb: 18, oversample: false,
  }, { meter: true }).bodyGr)
  const plain = (x) => {
    const k = new LA2AKernel(SR)
    k.setParams({ inputAlignDb: 18, oversample: false })
    const gr = []
    const out = new Float32Array(128)
    for (let o = 0; o + 128 <= x.length; o += 128) {
      k.process([x.subarray(o, o + 128)], [out], 128)
      gr.push(k.grDb)
    }
    return avg(gr)
  }
  const clean = puffedPhrase(false)
  const popped = puffedPhrase(true)
  const voxExtra = vox(popped) - vox(clean)
  const plainExtra = plain(popped) - plain(clean)
  assert.ok(voxExtra < 1, `VoxPressor Body: +${voxExtra.toFixed(2)} dB from plosives`)
  assert.ok(voxExtra < 0.8 * plainExtra,
    `VoxPressor +${voxExtra.toFixed(2)} dB against a plain LA-2A's +${plainExtra.toFixed(2)}`)
})

test('listen plays a detector instead of the output', () => {
  const x = speech.subarray(0, SR)
  const out = processVoxPressorBuffer([x], SR, { listen: 'body', oversample: false }).channelData[0]
  const normal = processVoxPressorBuffer([x], SR, { oversample: false }).channelData[0]
  assert.notDeepEqual(out, normal)
  // A plosive-ducked, sibilance-shelved copy of the voice: quieter, not silent.
  assert.ok(peak(out) > 0 && peak(out) < peak(x) * 1.5)
})

// ── Knobs and measurement ───────────────────────────────────────────────────

/**
 * What the app does: kernel params from the panel (knobs + the file's
 * alignment), then the measurement, with both limiters at the source peak.
 */
function measure(x, panel = {}, extra = {}) {
  const state = { ...VOX_DEFAULTS, alignDb: inputAlignDbFor([x], SR), cornerHz: 70, ...panel }
  const kp = toKernelParams(state)
  const r = measureVoxPressor([x], SR, { ...kp, ...extra })
  // As the app does: the measured values go back into the panel state and the
  // kernel params are derived again (stages that wait for a measurement start).
  const measured = {}
  for (const k of VOX_MEASURED_KEYS) if (k in r) measured[k] = r[k]
  return { kp, r, params: { ...toKernelParams({ ...state, ...measured }), ...extra, ...r } }
}

const LEVELS = [-34, -24, -14]
const atDefaults = LEVELS.map((levelDb) => {
  const x = narration(SR, { seconds: 12, levelDb })
  return { levelDb, x, ...measure(x) }
})

test('aligned knobs do the same at any recording level', () => {
  const [a, b, c] = atDefaults.map(s => s.r)
  for (const [lo, hi] of [[a, b], [b, c]]) {
    assert.ok(Math.abs(lo.peaksDb - hi.peaksDb) < 0.2, `peaks ${lo.peaksDb.toFixed(2)} vs ${hi.peaksDb.toFixed(2)}`)
    assert.ok(Math.abs(lo.bodyDb - hi.bodyDb) < 0.3, `body ${lo.bodyDb.toFixed(2)} vs ${hi.bodyDb.toFixed(2)}`)
    // ⚠ THE LA-2A STAGE'S MAKEUP IS NOT EXACTLY LEVEL-INVARIANT, AND THAT IS
    // THE LA-2A: its output valve is driven by absolute level by design, so a
    // hotter file shapes its loudest samples differently. The 1176 stage is
    // exact (next test).
    const total = q => q.bodyMakeupDb + q.makeupDb
    assert.ok(Math.abs(total(lo) - total(hi)) < 0.6,
      `LA-2A makeup ${total(lo).toFixed(2)} vs ${total(hi).toFixed(2)} dB across 10 dB of level`)
  }
  // And the defaults do something on narration.
  assert.ok(a.peaksDb > 1 && a.bodyDb > 1, `defaults: peaks ${a.peaksDb.toFixed(2)}, body ${a.bodyDb.toFixed(2)}`)
})

test('the 1176 stage\'s makeup is exactly level-invariant', () => {
  const makeups = LEVELS.map(levelDb => measure(narration(SR, { seconds: 12, levelDb }), { body: 0 }).r.peaksMakeupDb)
  assert.ok(Math.max(...makeups) - Math.min(...makeups) < 0.02, makeups.map(m => m.toFixed(3)).join(' / '))
})

test('a light Peaks takes the peaks and barely touches the voice, at every speed', () => {
  // ⚠ NOT AT THE DEFAULT. The Peaks scale is calibrated on the owner's two
  // clips (Peaks 3 ≈ 3 dB off their peaks, ≤ 0.04 dB of voice); this synthetic
  // narration is far peakier and gives up ~6 dB at 3.
  // ⚠ A SLOWER SPEED TOUCHES THE VOICE MORE — its release holds the gain down
  // after each peak — which is the price GENTLE pays for its lower ripple.
  for (const { levelDb, x } of atDefaults) {
    const touched = {}
    for (const speed of ['fast', 'normal', 'gentle']) {
      const { r } = measure(x, { peaks: 0.5, body: 0, speed })
      assert.ok(r.peaksDb > 2, `${levelDb} ${speed}: only ${r.peaksDb.toFixed(2)} dB off the peaks`)
      assert.ok(r.peaksBodyDb < 1, `${levelDb} ${speed}: body touched ${r.peaksBodyDb.toFixed(2)} dB`)
      touched[speed] = r.peaksBodyDb
    }
    assert.ok(touched.fast < touched.normal && touched.normal < touched.gentle,
      `${levelDb}: ${JSON.stringify(touched)}`)
  }
})

test('Peaks is never capped: more takes more off, and its cost is reported', () => {
  // Warn, don't cap (owner's call): the knob goes where it is turned and the
  // readout says what it is costing the voice.
  const { x } = atDefaults[1]
  const runs = [1, 4, 8].map(v => measure(x, { peaks: v, body: 0 }).r)
  assert.ok(runs[0].peaksDb < runs[1].peaksDb && runs[1].peaksDb < runs[2].peaksDb,
    runs.map(r => r.peaksDb.toFixed(2)).join(' / '))
  assert.ok(runs[0].peaksBodyDb <= runs[1].peaksBodyDb && runs[1].peaksBodyDb <= runs[2].peaksBodyDb)
  assert.ok(runs[2].peaksBodyDb > PEAKS_BODY_WARN_DB,
    `voice touched ${runs[2].peaksBodyDb.toFixed(2)} dB at Peaks 8`)
})

test('the Body stage does not move when the Peaks makeup does', () => {
  // The LA-2A hears the 1176 stage's made-up output; its offset is taken net
  // of that makeup, so a makeup measurement landing never shifts the leveling.
  const x = atDefaults[1].x
  const kp = { ...atDefaults[1].kp, oversample: false }
  const gr = m => processVoxPressorBuffer([x], SR, { ...kp, peaksMakeupDb: m }, { meter: true }).bodyGr
  const a = gr(0)
  const b = gr(6)
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]))
  assert.ok(worst < 0.01, `Body reduction moved ${worst.toFixed(4)} dB with 6 dB of Peaks makeup`)
})

test('makeup restores the source peak, and the voice comes out louder', () => {
  for (const { levelDb, x, params } of atDefaults) {
    const p = { ...params, peaksCeilingDb: db(peak(x)), bodyCeilingDb: db(peak(x)) }
    // Base rate: what was measured. The limiters hold the peak on the source's.
    const base = processVoxPressorBuffer([x], SR, { ...p, oversample: false }, { compensate: true }).channelData
    const dPeak = db(peak(base[0])) - db(peak(x))
    // ≤ 1e-5 dB: Density's anchor divides and multiplies back in float32.
    assert.ok(dPeak <= 1e-5 && dPeak > -0.3, `${levelDb}: peak moved ${dPeak.toExponential(2)} dB`)
    // What the compressors took off the peaks comes back as level.
    const gain = db(gatedRmsOfChannels(base, SR)) - db(gatedRmsOfChannels([x], SR))
    assert.ok(gain > 1, `${levelDb}: only ${gain.toFixed(2)} dB louder`)
    // The rendered (oversampled) path never exceeds the source peak.
    const out = processVoxPressorBuffer([x], SR, p).channelData[0]
    assert.ok(db(peak(out)) - db(peak(x)) <= 1e-5,
      `${levelDb}: peak ${db(peak(x)).toFixed(4)} → ${db(peak(out)).toFixed(4)}`)
  }
})

test('the exact whole-region pass reproduces a whole-region measurement', () => {
  // Apply re-measures the per-stage restores this way when the region outgrew
  // the measurement's window; on a region measured whole, the two must agree.
  const { x, params } = atDefaults[1]
  const exact = measureVoxPressorExact([x], SR, params, params.peaksCeilingDb)
  for (const k of ['peaksMakeupDb', 'peaksCeilingDb', 'peaksRestoreDb', 'bodyCeilingDb', 'makeupDb']) {
    assert.ok(Math.abs(exact[k] - params[k]) < 1e-6, `${k}: ${exact[k]} vs ${params[k]}`)
  }
})

test('knobs at 0 switch the stages off', () => {
  const { kp, r } = measure(speech, { peaks: 0, body: 0 })
  assert.equal(kp.peaksOn, false)
  assert.equal(kp.bodyOn, false)
  assert.ok(Math.abs(r.makeupDb) < 1e-9 && Math.abs(r.peaksMakeupDb) < 1e-9)
})

test('a stage is bypassed until the file is aligned, not run uncalibrated', () => {
  const unaligned = toKernelParams({ ...VOX_DEFAULTS })
  assert.equal(unaligned.peaksOn, false)
  assert.equal(unaligned.bodyOn, false)
  // And so the kernel renders a pure delay until the alignment lands.
  const { channelData, latencySamples } = processVoxPressorBuffer([speech], SR, unaligned)
  for (let i = latencySamples; i < speech.length; i++) {
    if (channelData[0][i] !== speech[i - latencySamples]) assert.fail(`sample ${i} differs`)
  }
  const aligned = toKernelParams({ ...VOX_DEFAULTS, alignDb: 3 })
  assert.equal(aligned.peaksOn, true)
  assert.equal(aligned.bodyOn, true)
  assert.equal(aligned.peaksInput, PEAKS_INPUT_KNOB)
  assert.equal(aligned.bodyPeakReduction, VOX_DEFAULTS.body)
})

test('the Peaks scale is linear in detector drive, Peaks 0 its first catch', () => {
  // The knob adds `PEAKS_DRIVE_PER_STEP_DB` of detector drive a step, on top
  // of the file's alignment; at 12:1 that is ~0.9 dB off the peaks a dB.
  const kp = v => toKernelParams({ ...VOX_DEFAULTS, peaks: v, alignDb: 2 })
  assert.ok(Math.abs((kp(5).peaksAlignDb - kp(3).peaksAlignDb) - 2 * PEAKS_DRIVE_PER_STEP_DB) < 1e-9)
  assert.ok(Math.abs(kp(3).peaksAlignDb - (2 + peaksDriveDb(3))) < 1e-9)
  assert.equal(kp(3).bodyAlignDb, 2)
  const { x } = atDefaults[1]
  const steps = [4, 6, 8].map(v => measure(x, { peaks: v, body: 0 }).r.peaksDb)
  const perStep = [(steps[1] - steps[0]) / 2, (steps[2] - steps[1]) / 2]
  for (const d of perStep) assert.ok(d > 0.8 && d < 1.2, `${d.toFixed(2)} dB off the peaks per step`)
})

test('SPEED AUTO sets the release from the voice\'s pitch, inside GENTLE..FAST', () => {
  const rel = f0 => releaseSecondsForDial(peaksTiming('auto', f0).release)
  // Sixteen pitch periods: a low voice gets a slower release than a high one.
  assert.ok(Math.abs(rel(100) - 0.16) < 0.002, `${rel(100)} s at 100 Hz`)
  assert.ok(rel(70) > rel(140) && rel(140) > rel(200))
  // Never slower than GENTLE, never faster than FAST.
  assert.equal(peaksTiming('auto', 20).release, PEAKS_SPEEDS.gentle.release)
  assert.equal(peaksTiming('auto', 2000).release, PEAKS_SPEEDS.fast.release)
  // Unmeasured: NORMAL. Fixed speeds ignore the pitch.
  assert.deepEqual(peaksTiming('auto', null), { ...PEAKS_SPEEDS.normal })
  assert.deepEqual(peaksTiming('fast', 70), { ...PEAKS_SPEEDS.fast })
})

test('the measurement reports the voice\'s F0 and a gain ripple that falls with a slower speed', () => {
  const { x } = atDefaults[1]
  const at = speed => measure(x, { body: 0, speed }, { cornerHz: undefined }).r
  const fast = at('fast')
  const gentle = at('gentle')
  assert.ok(fast.voiceF0Hz > 60 && fast.voiceF0Hz < 400, `F0 ${fast.voiceF0Hz}`)
  assert.ok(Number.isFinite(fast.peaksRippleDb) && Number.isFinite(gentle.peaksRippleDb))
  assert.ok(gentle.peaksRippleDb < fast.peaksRippleDb - 1,
    `ripple ${gentle.peaksRippleDb.toFixed(1)} (gentle) vs ${fast.peaksRippleDb.toFixed(1)} (fast)`)
})

// ── De-ess, Parallel, Density ───────────────────────────────────────────────

function hfEnergyDb(chs, hz = 5000) {
  // Two-pole high-passed energy, a plain sibilance proxy.
  let e = 0
  for (const x of chs) {
    const c = Math.exp(-2 * Math.PI * hz / SR)
    let y1 = 0
    let x1 = 0
    let z1 = 0
    let w1 = 0
    for (let i = 0; i < x.length; i++) {
      const y = c * (y1 + x[i] - x1)
      x1 = x[i]
      y1 = y
      const z = c * (z1 + y - w1)
      w1 = y
      z1 = z
      e += z * z
    }
  }
  return 10 * Math.log10(e)
}

test('the measurement solves the stages after Body on what each hears', () => {
  const { r } = measure(atDefaults[1].x)
  assert.ok(Number.isFinite(r.deEssLevelOffsetDb), 'de-ess level offset')
  assert.ok(Number.isFinite(r.parallelAlignDb), 'parallel alignment')
  assert.ok(Number.isFinite(r.parallelMakeupDb), 'parallel makeup')
  assert.ok(Number.isFinite(r.sourcePeakDb))
  // The makeup is solved on the blend, so it moves with the Mix.
  const heavier = measure(atDefaults[1].x, { parallel: 80 }).r
  assert.notEqual(heavier.parallelMakeupDb, r.parallelMakeupDb)
  // Parallel 0 measures nothing for it.
  const off = measure(atDefaults[1].x, { parallel: 0 }).r
  assert.equal(off.parallelAlignDb, null)
  assert.equal(off.parallelMakeupDb, null)
})

test('each later stage does its job and none of them raises the source peak', () => {
  const x = narration(SR, { seconds: 12, levelDb: -24 })
  const sourcePeak = peak(x)
  const render = (panel) => {
    const { params } = measure(x, { peaks: 3, body: 57, deEss: 0, parallel: 0, density: 0, ...panel })
    return processVoxPressorBuffer([x], SR, params, { compensate: true }).channelData
  }
  const dry = render({})
  // De-ess takes the top end down.
  const deEssed = render({ deEss: 80 })
  assert.ok(hfEnergyDb(deEssed) < hfEnergyDb(dry) - 0.5,
    `>5 kHz ${hfEnergyDb(dry).toFixed(2)} → ${hfEnergyDb(deEssed).toFixed(2)} dB`)
  // Parallel raises what sits under the peaks: the fast copy's makeup is held
  // to the blend's 99.9th percentile (the LA-2A mix law), so the level rises.
  // ⚠ Scheps Parallel, which this replaced, was level-FLAT here (|Δ| < 1 dB,
  // slightly negative): its opto copy was barely denser than the dry.
  const par = render({ parallel: 60 })
  const parGain = db(gatedRmsOfChannels(par, SR)) - db(gatedRmsOfChannels(dry, SR))
  assert.ok(parGain > 0.3, `Parallel: only ${parGain.toFixed(2)} dB louder`)
  // ⚠ AND IT MUST NOT UNDO THE DE-ESSER: its detector hears sibilance shelved
  // up, so the "s" is compressed in the copy like a vowel instead of lifted by
  // the copy's makeup. On this narration the top end then rises well under the
  // level (−1.57 dB at +2.66); with a plain detector it rose WITH it (+2.98 at
  // +3.01) — on the owner's "Messy and Bright" it rose past it.
  const hfGain = hfEnergyDb(par) - hfEnergyDb(dry)
  assert.ok(hfGain < parGain - 1.5, `Parallel: >5 kHz +${hfGain.toFixed(2)} dB at +${parGain.toFixed(2)} of level`)
  // Its peak restore puts the blend's peak back on the source's.
  assert.ok(db(peak(par[0])) - db(sourcePeak) > -0.1, `Parallel peak ${(db(peak(par[0])) - db(sourcePeak)).toFixed(2)} dB`)
  const den = render({ density: 60 })
  const denGain = db(gatedRmsOfChannels(den, SR)) - db(gatedRmsOfChannels(dry, SR))
  assert.ok(denGain > 0.3, `Density: only ${denGain.toFixed(2)} dB louder`)
  for (const [name, out] of [['parallel', par], ['density', den], ['all', render({ deEss: 40, parallel: 60, density: 60 })]]) {
    assert.ok(db(peak(out[0])) - db(sourcePeak) <= 1e-5,
      `${name}: peak ${db(peak(out[0])).toFixed(4)} over ${db(sourcePeak).toFixed(4)}`)
  }
})

test('Density holds the source peak even where samples hide inter-sample peaks', () => {
  // Broadband noise: its samples hide inter-sample peaks over the sample peak.
  // Anchored at the SAMPLE peak, the Inflator's oversampled curve meets them
  // over full scale, clips them there, and its downsampler rings back over —
  // 1.71 dB without the last limiter (0.43 on synthetic narration with
  // sibilants, 0.18 on the owner's "Messy and Bright"). That is its job.
  const n = SR
  const x = new Float32Array(n)
  let seed = 1
  for (let i = 0; i < n; i++) x[i] = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.6
  const srcPeakDb = db(peak(x))
  const out = processVoxPressorBuffer([x], SR, {
    peaksOn: false, bodyOn: false, density: 1, sourcePeakDb: srcPeakDb,
  }, { compensate: true }).channelData[0]
  assert.ok(db(peak(out)) - srcPeakDb <= 1e-5, `peak ${(db(peak(out)) - srcPeakDb).toFixed(3)} dB over the source`)
  // And without the anchor nothing runs: a pure delay.
  const off = processVoxPressorBuffer([x], SR, { peaksOn: false, bodyOn: false, density: 1 }, { compensate: true }).channelData[0]
  for (let i = 0; i < n; i++) if (off[i] !== x[i]) assert.fail(`sample ${i} differs`)
})

test('Parallel waits for its measurement; Density waits for its anchor', () => {
  const unmeasured = toKernelParams({ ...VOX_DEFAULTS, alignDb: 0 })
  assert.equal(unmeasured.parallelOn, false)
  assert.equal(unmeasured.deEssOn, true)
  assert.equal(unmeasured.sourcePeakDb, null)
  const halfMeasured = toKernelParams({ ...VOX_DEFAULTS, alignDb: 0, parallelAlignDb: 2 })
  assert.equal(halfMeasured.parallelOn, false)
  const measured = toKernelParams({
    ...VOX_DEFAULTS, alignDb: 0, parallelAlignDb: 2, parallelMakeupDb: -6, sourcePeakDb: -3,
  })
  assert.equal(measured.parallelOn, true)
  assert.equal(measured.sourcePeakDb, -3)
})

test('Peaks trims a sibilant spike instead of letting it set the makeup', () => {
  // The owner's "Messy and Bright" failure, synthetic: a voice with one bright
  // "s" spike well above every voiced peak. With the 1176 deaf to sibilance the
  // spike passed untouched and the peak-restoring makeup was pinned to it.
  const x = narration(SR, { seconds: 12, levelDb: -24, sibilants: false }).slice()
  let s = 3
  const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  let vPeak = 0
  for (const v of x) vPeak = Math.max(vPeak, Math.abs(v))
  const at = Math.round(6.05 * SR)
  let prev = 0
  for (let i = 0; i < Math.round(0.08 * SR); i++) {
    const w = rnd() * 2 - 1
    x[at + i] += 2.2 * vPeak * Math.sin(Math.PI * i / (0.08 * SR)) * (w - prev)
    prev = w
  }
  const gain = (sib) => {
    // The Peaks stage alone: the parallel 1176 hears sibilance on purpose and
    // restores its own peak, which would hide the difference measured here.
    const { params } = measure(x, { body: 0, deEss: 0, parallel: 0, density: 0 }, { peaksSibilance: sib })
    const out = processVoxPressorBuffer([x], SR, { ...params, oversample: false }).channelData
    return db(gatedRmsOfChannels(out, SR)) - db(gatedRmsOfChannels([x], SR))
  }
  const deaf = gain(true)
  const hearing = gain(false)
  assert.ok(hearing > deaf + 1, `hearing sibilance ${hearing.toFixed(2)} dB vs deaf ${deaf.toFixed(2)} dB`)
  assert.ok(hearing > 1, `the default Peaks should make the voice louder: ${hearing.toFixed(2)} dB`)
})

test('a lone click in silence still measures (its 99.9th percentile is zero)', () => {
  // The LA-2A's makeup plan renders nothing when the input's percentile is
  // zero; the measurement used to read the meter of a render that never ran.
  const x = new Float32Array(SR * 4)
  for (let i = 0; i < 40; i++) x[2 * SR + i] = 0.5 * Math.sin(Math.PI * i / 40)
  const { r } = measure(x, { peaks: 0 })
  assert.equal(r.bodyMakeupDb, 0)
  assert.ok(Number.isFinite(r.bodyDb))
  assert.ok(Number.isFinite(r.makeupDb))
})

test('the Peaks / Body renders ignore a stale source peak', () => {
  // The parallel limiter holds `sourcePeakDb` whether Parallel is on or not,
  // so a previous region's (lower) peak used to limit the makeup renders.
  const x = speech.slice()
  const kp = toKernelParams({ ...VOX_DEFAULTS, alignDb: inputAlignDbFor([x], SR), cornerHz: 70 })
  const fresh = measureVoxPressor([x], SR, kp)
  const stale = measureVoxPressor([x], SR, { ...kp, sourcePeakDb: db(peak(x)) - 12 })
  for (const k of ['peaksMakeupDb', 'bodyMakeupDb', 'makeupDb', 'peaksDb', 'bodyDb']) {
    assert.equal(stale[k], fresh[k], k)
  }
})

test('an unmeasurable corner is sent as null, so a merging kernel resets to its default', () => {
  assert.equal(toKernelParams({ ...VOX_DEFAULTS, alignDb: 0, cornerHz: null }).cornerHz, null)
  assert.equal(toKernelParams({ ...VOX_DEFAULTS, alignDb: 0, cornerHz: 95 }).cornerHz, 95)
})

test('BENCH: the parallel LA-2A swaps in with the same latency, measures, and holds the peak', () => {
  const x = narration(SR, { seconds: 12, levelDb: -24 })
  const sourcePeakDb = db(peak(x))
  for (const comp of ['1176', 'la2a']) {
    const kp = toKernelParams({ ...VOX_DEFAULTS, alignDb: 0, parallelComp: comp, parallelAlignDb: 0, parallelMakeupDb: 0 })
    assert.equal(kp.parallelComp, comp)
    assert.equal(voxLatencySamples(kp, SR), new VoxPressorKernel(SR).latencySamples, comp)
    const k = new VoxPressorKernel(SR)
    k.setParams(kp)
    assert.equal(k.latencySamples, new VoxPressorKernel(SR).latencySamples, `${comp}: switching moved the audio`)
  }
  const { r, params } = measure(x, { parallel: 60, parallelComp: 'la2a' })
  assert.ok(Number.isFinite(r.parallelMakeupDb) && Number.isFinite(r.parallelRestoreDb), 'LA-2A parallel measured')
  const out = processVoxPressorBuffer([x], SR, params, { compensate: true }).channelData
  assert.ok(db(peak(out[0])) - sourcePeakDb <= 1e-5, `LA-2A parallel: peak ${(db(peak(out[0])) - sourcePeakDb).toFixed(4)} dB over`)
})

test('the Parallel LA-2A renders as an LA Vintage 2A slot after VoxPressor (owner: keep them consistent)', async () => {
  const { computeAutoMakeupPlan } = await import('../../src/audio/la2aProcessor.js')
  const { toKernelParams: la2aKp, LA2A_DEFAULTS } = await import('../../src/audio/effects/la2aParams.js')
  const x = narration(SR, { seconds: 12, levelDb: -24 })
  const align = inputAlignDbFor([x], SR)
  const render = (panel) => {
    const { params } = measure(x, { density: 0, ...panel })
    return processVoxPressorBuffer([x], SR, params, { compensate: true }).channelData[0]
  }
  const core = render({ parallel: 0 })
  // The slot as its preview runs: PR 50 / Mix 50, aligned on the unprocessed
  // file, its percentile makeup and sized ceiling at the source peak.
  const base = la2aKp({ ...LA2A_DEFAULTS, peakReduction: 50, mix: 0.5, inputAlignDb: align })
  const plan = computeAutoMakeupPlan([core], SR, base, { reference: 'percentile' })
  const k = new LA2AKernel(SR)
  k.setParams({ ...base, gainDb: plan.makeupDb, ceilingDb: db(peak(x)), ceilingKneeDb: plan.ceilingKneeDb })
  const slot = runKernel(k, Float32Array.from({ length: core.length + k.latencySamples }, (_, i) => core[i] ?? 0))
    .subarray(k.latencySamples)
  const vox = render({ parallel: 50, parallelComp: 'la2a' })
  let e = 0
  let d = 0
  for (let i = 0; i < core.length; i++) { e += slot[i] ** 2; d += (slot[i] - vox[i]) ** 2 }
  const diffDb = 10 * Math.log10(d / e)
  // −75 to −81 dB on the owner's clips; the lookahead limiter this replaced
  // put them −32.5 dB apart.
  assert.ok(diffDb < -55, `VoxPressor's LA-2A vs the slot: ${diffDb.toFixed(1)} dB re signal`)
})

test('BENCH: the Parallel de-esser takes the copy\'s top end down, leaves the level, holds the peak', () => {
  const x = narration(SR, { seconds: 12, levelDb: -24 })
  const sourcePeakDb = db(peak(x))
  for (const parallelComp of ['1176', 'la2a']) {
    const render = (panel) => {
      const { r, params } = measure(x, { peaks: 3, body: 57, deEss: 0, parallel: 60, density: 0, parallelComp, ...panel })
      assert.ok(Number.isFinite(r.parallelMakeupDb), `${parallelComp}: measured`)
      return processVoxPressorBuffer([x], SR, params, { compensate: true }).channelData
    }
    const plain = render({})
    const deEssed = render({ parallelDeEss: 50 })
    const hf = hfEnergyDb(deEssed) - hfEnergyDb(plain)
    const level = db(gatedRmsOfChannels(deEssed, SR)) - db(gatedRmsOfChannels(plain, SR))
    assert.ok(hf < -1, `${parallelComp}: >5 kHz only ${hf.toFixed(2)} dB`)
    assert.ok(Math.abs(level) < 0.3, `${parallelComp}: level moved ${level.toFixed(2)} dB`)
    assert.ok(db(peak(deEssed[0])) - sourcePeakDb <= 1e-5,
      `${parallelComp}: peak ${(db(peak(deEssed[0])) - sourcePeakDb).toFixed(4)} dB over`)
  }
})
