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
  processVoxPressorBuffer, VOX_KERNEL_DEFAULTS, peaksTap, BODY_TAP, voxLatencySamples,
} from '../../src/audio/voxPressorProcessor.js'
import { LinkedPeakLimiter } from '../../src/audio/dsp/peakLimiter.js'
import {
  voiceDetectorSections, PLOSIVE_SHELF_DB, SIBILANCE_SHELF_DB,
} from '../../src/audio/dsp/voiceDetector.js'
import {
  solveVoxPressor, PEAKS_BODY_WARN_DB, measureVoxPressorExact,
} from '../../src/audio/voxPressorSolve.js'
import { magnitudeResponseDb } from '../../src/audio/dsp/biquad.js'
import { gatedRmsOfChannels } from '../../src/audio/dsp/inputAlign.js'

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

// ── Solves ──────────────────────────────────────────────────────────────────

const LEVELS = [-34, -24, -14]
const solved = LEVELS.map((levelDb) => {
  const x = narration(SR, { seconds: 12, levelDb })
  return { levelDb, x, r: solveVoxPressor([x], SR, { peaksDb: 3, bodyDb: 4, wholeRegion: true, cornerHz: 70 }) }
})

test('Peaks and Body land on their targets', () => {
  for (const { levelDb, r } of solved) {
    assert.ok(Math.abs(r.peaksDb - 3) <= 0.1, `${levelDb}: peaks ${r.peaksDb.toFixed(3)}`)
    assert.ok(Math.abs(r.bodyDb - 4) <= 0.1, `${levelDb}: body ${r.bodyDb.toFixed(3)}`)
    assert.equal(r.peaksLimited, false)
  }
})

test('the solves are level-invariant: offsets track the file, results do not', () => {
  const [a, b, c] = solved.map(s => s.r)
  for (const [lo, hi] of [[a, b], [b, c]]) {
    assert.ok(Math.abs((lo.peaksAlignDb - hi.peaksAlignDb) - 10) < 0.2, 'peaks offset follows level')
    assert.ok(Math.abs((lo.bodyAlignDb - hi.bodyAlignDb) - 10) < 0.3, 'body offset follows level')
    // ⚠ THE LA-2A STAGE'S MAKEUP IS NOT EXACTLY LEVEL-INVARIANT, AND THAT IS
    // THE LA-2A: its output valve is driven by absolute level by design, so a
    // hotter file shapes its loudest samples differently. The 1176 stage is
    // exact (next test).
    const total = q => q.bodyMakeupDb + q.makeupDb
    assert.ok(Math.abs(total(lo) - total(hi)) < 0.6,
      `LA-2A makeup ${total(lo).toFixed(2)} vs ${total(hi).toFixed(2)} dB across 10 dB of level`)
  }
})

test('the 1176 stage\'s makeup is exactly level-invariant', () => {
  const makeups = [-34, -24, -14].map(levelDb => solveVoxPressor(
    [narration(SR, { seconds: 12, levelDb })], SR, { peaksDb: 3, bodyDb: 0, cornerHz: 70 },
  ).peaksMakeupDb)
  assert.ok(Math.max(...makeups) - Math.min(...makeups) < 0.02, makeups.map(m => m.toFixed(3)).join(' / '))
})

test('at Peaks 3 the 1176 leaves the body alone', () => {
  for (const { levelDb, r } of solved) {
    assert.ok(r.peaksBodyDb < 0.5, `${levelDb}: body touched ${r.peaksBodyDb.toFixed(2)} dB`)
  }
})

test('Peaks is never capped: a large target is reached and its cost reported', () => {
  // Warn, don't cap (owner's call). The fixed floor this replaced stopped a real
  // clip at 2.57 dB for every setting from 3 to 10; the knob must now deliver.
  const { x } = solved[1]
  const reached = [4, 7, 10].map(t => solveVoxPressor([x], SR, { peaksDb: t, bodyDb: 0, cornerHz: 70 }))
  for (const [i, t] of [4, 7, 10].entries()) {
    assert.equal(reached[i].peaksLimited, false, `Peaks ${t} limited`)
    assert.ok(Math.abs(reached[i].peaksDb - t) <= 0.1, `Peaks ${t}: reached ${reached[i].peaksDb.toFixed(2)}`)
  }
  // The cost is measured and grows with the knob; at 10 it is well past the
  // warning, which is what the panel's amber note reports.
  assert.ok(reached[0].peaksBodyDb <= reached[1].peaksBodyDb && reached[1].peaksBodyDb <= reached[2].peaksBodyDb)
  assert.ok(reached[2].peaksBodyDb > PEAKS_BODY_WARN_DB,
    `voice touched ${reached[2].peaksBodyDb.toFixed(2)} dB at Peaks 10`)
})

test('makeup restores the source peak, and the voice comes out louder', () => {
  for (const { levelDb, x, r } of solved) {
    const params = { ...VOX_KERNEL_DEFAULTS, ...r, cornerHz: 70 }
    // Base rate: what the solve measured. The peak lands back on the source's,
    // a hair under it where the ceiling's 0.5 dB margin bends the top sample.
    const base = processVoxPressorBuffer([x], SR, { ...params, oversample: false }).channelData
    const dPeak = db(peak(base[0])) - db(peak(x))
    assert.ok(dPeak <= 0 && dPeak > -0.3, `${levelDb}: peak moved ${dPeak.toFixed(3)} dB`)
    // What Peaks 3 / Body 4 took off the peaks comes back as level.
    const gain = db(gatedRmsOfChannels(base, SR)) - db(gatedRmsOfChannels([x], SR))
    assert.ok(gain > 1, `${levelDb}: only ${gain.toFixed(2)} dB louder`)
    // The rendered (oversampled) path never exceeds the source peak.
    const out = processVoxPressorBuffer([x], SR, params).channelData[0]
    assert.ok(peak(out) <= peak(x), `${levelDb}: peak ${db(peak(x)).toFixed(3)} → ${db(peak(out)).toFixed(3)}`)
  }
})

test('the exact whole-region pass reproduces a whole-region solve', () => {
  // Apply re-measures the per-stage restores this way when the region outgrew
  // the solve's window; on a region the solve saw whole, the two must agree.
  const { x, r } = solved[1]
  const exact = measureVoxPressorExact([x], SR, { ...r, cornerHz: 70 }, r.peaksCeilingDb)
  for (const k of ['peaksMakeupDb', 'peaksCeilingDb', 'peaksRestoreDb', 'bodyAlignDb', 'bodyCeilingDb', 'makeupDb']) {
    assert.ok(Math.abs(exact[k] - r[k]) < 1e-6, `${k}: ${exact[k]} vs ${r[k]}`)
  }
})

test('zero targets switch the stages off', () => {
  const r = solveVoxPressor([speech], SR, { peaksDb: 0, bodyDb: 0, cornerHz: 70 })
  assert.equal(r.peaksOn, false)
  assert.equal(r.bodyOn, false)
  assert.ok(Math.abs(r.makeupDb) < 1e-9)
})

test('a stage with no measured offset is bypassed, not run uncalibrated', async () => {
  const { toKernelParams, VOX_DEFAULTS } = await import('../../src/audio/effects/voxPressorParams.js')
  const unmeasured = toKernelParams({ ...VOX_DEFAULTS })
  assert.equal(unmeasured.peaksOn, false)
  assert.equal(unmeasured.bodyOn, false)
  // And so the kernel renders a pure delay until the solve lands.
  const { channelData, latencySamples } = processVoxPressorBuffer([speech], SR, unmeasured)
  for (let i = latencySamples; i < speech.length; i++) {
    if (channelData[0][i] !== speech[i - latencySamples]) assert.fail(`sample ${i} differs`)
  }
  const measured = toKernelParams({ ...VOX_DEFAULTS, peaksAlignDb: -10, bodyAlignDb: 6 })
  assert.equal(measured.peaksOn, true)
  assert.equal(measured.bodyOn, true)
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
    const r = solveVoxPressor([x], SR, { peaksDb: 3, bodyDb: 0, cornerHz: 70, peaksSibilance: sib })
    const out = processVoxPressorBuffer([x], SR, { ...r, peaksSibilance: sib, oversample: false }).channelData
    return db(gatedRmsOfChannels(out, SR)) - db(gatedRmsOfChannels([x], SR))
  }
  const deaf = gain(true)
  const hearing = gain(false)
  assert.ok(hearing > deaf + 1, `hearing sibilance ${hearing.toFixed(2)} dB vs deaf ${deaf.toFixed(2)} dB`)
  assert.ok(hearing > 1, `Peaks 3 should make the voice louder: ${hearing.toFixed(2)} dB`)
})
