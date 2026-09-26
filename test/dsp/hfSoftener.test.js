/**
 * Run with:  npm test
 *
 * Dynamic HF Softener. Most of these are the spec's own "objective checks" —
 * the failure modes that are hard to hear on a single pass — run against
 * deterministic synthetic voice so they stay in the unit suite.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Biquad,
  Follower,
  HF_SOFTENER_TUNING as T,
  HFSoftenerKernel,
  HF_SOFTENER_KERNEL_DEFAULTS,
  HF_SOFTENER_PREROLL_S,
  ROTATOR_DETECTOR_TRIM_DB,
  adaptiveThresholdDb,
  amountToMaxDepthDb,
  amountToThresholdDb,
  contextToKappa,
  gainComputerDb,
  levelOffsetDbFor,
  amountToSlope,
  amountToCompressionRatio,
  processHFSoftenerBuffer,
  rotatorMaxGroupDelayMs,
  rotatorSections,
  shelfSection,
  softenerSections,
} from '../../src/audio/hfSoftenerProcessor.js'
import { bandpass, highpass, lowpass, magnitudeResponseDb, peaking } from '../../src/audio/dsp/biquad.js'
import { processResonanceBuffer } from '../../src/audio/resonanceProcessor.js'
import {
  HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES, HF_RESO_ZONES, hfResoKernelParams,
} from '../../src/audio/hfSoftenerResoStage.js'

const SR = 48000

function lcg(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return (s / 4294967296) * 2 - 1
  }
}

/**
 * Speech-like material on a one-second cycle, with a label per sample:
 * 1 vowel (0–.35 s, .39–.6 s), 2 sibilant (.35–.39 s in-phrase, .70–.735 s
 * isolated), 3 breath (.9–.99 s; .85–.9 s is labelled 4, release tail), 0 gap.
 *
 * Calibrated to close-miked narration: vowels −18 dBFS RMS, sibilants −28 dBFS
 * RMS with their energy 5–9 kHz, breath −54 dBFS RMS. The vowel source has a
 * glottal roll-off — a bare pulse train has a flat top end and puts vowels
 * straight into the detector, which no voice does.
 */
function makeSpeech(sr, { seconds = 5, seed = 3 } = {}) {
  const rnd = lcg(seed)
  const n = Math.round(sr * seconds)
  const x = new Float32Array(n)
  const labels = new Uint8Array(n)
  const g = db => Math.pow(10, db / 20)
  const glot = new Biquad(lowpass(sr, 400, 0.7))
  const f1 = new Biquad(peaking(sr, 700, 3, 12))
  const f2 = new Biquad(peaking(sr, 1200, 3, 10))
  const vlp = new Biquad(lowpass(sr, 3500, 0.7))
  const sh = new Biquad(highpass(sr, 5000, 0.7))
  const sl = new Biquad(lowpass(sr, 9000, 0.7))
  const bh = new Biquad(highpass(sr, 300, 0.7))
  const bl = new Biquad(lowpass(sr, 6000, 0.5))
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = (i % sr) / sr
    let v = 0
    let lab = 0
    const voiced = t < 0.35 || (t >= 0.39 && t < 0.6)
    let pulse = 0
    if (voiced) {
      phase += 130 / sr
      if (phase >= 1) phase -= 1
      pulse = phase < 130 / sr ? 1 : 0
    }
    const vowel = vlp.tick(f2.tick(f1.tick(glot.tick(pulse))))
    if (voiced) {
      v = vowel * 100 * g(-18)
      lab = 1
    }
    const sib = sl.tick(sh.tick(rnd()))
    if ((t >= 0.35 && t < 0.39) || (t >= 0.7 && t < 0.735)) {
      const tt = t < 0.5 ? t - 0.35 : t - 0.7
      v += sib * g(-22) * 2.2 * Math.min(1, tt / 0.003)
      lab = 2
    }
    const br = bl.tick(bh.tick(rnd()))
    if (t >= 0.85 && t < 0.99) {
      v += br * g(-48) * 2
      lab = t < 0.9 ? 4 : 3
    }
    x[i] = v
    labels[i] = lab
  }
  return { x, labels }
}

function pink(n, seed = 1) {
  const rnd = lcg(seed)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0
  const o = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const w = rnd()
    b0 = 0.99886 * b0 + w * 0.0555179
    b1 = 0.99332 * b1 + w * 0.0750759
    b2 = 0.969 * b2 + w * 0.153852
    b3 = 0.8665 * b3 + w * 0.3104856
    b4 = 0.55 * b4 + w * 0.5329522
    b5 = -0.7616 * b5 - w * 0.016898
    o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.05
    b6 = w * 0.115926
  }
  return o
}

// ── Module A ────────────────────────────────────────────────────────────────

test('rotator: numerator is the reversed denominator, so magnitude is flat', () => {
  for (const sr of [44100, 48000, 96000]) {
    for (const c of rotatorSections(sr)) {
      assert.ok(Math.abs(c.b2 - 1) < 1e-15 && Math.abs(c.b1 - c.a1) < 1e-15 && Math.abs(c.b0 - c.a2) < 1e-15)
    }
    const freqs = Array.from({ length: 200 }, (_, i) => 20 * Math.pow(1000, i / 199))
    const db = magnitudeResponseDb(rotatorSections(sr), freqs.filter(f => f < sr / 2), sr)
    for (const v of db) assert.ok(Math.abs(v) < 0.01, `rotator is not flat: ${v} dB at ${sr}`)
  }
})

test('rotator: group delay stays under the 2 ms budget above 3 kHz', () => {
  // Measured 0.29 ms worst case, not the ~0.7 ms the spec estimated.
  for (const sr of [44100, 48000, 96000]) {
    const gd = rotatorMaxGroupDelayMs(sr)
    assert.ok(gd < T.maxGroupDelayMs, `${gd.toFixed(3)} ms at ${sr}`)
    assert.ok(gd > 0.2 && gd < 0.4, `group delay moved: ${gd.toFixed(3)} ms at ${sr}`)
  }
})

test('rotator: kernel refuses a cascade over the group-delay budget', () => {
  const slow = { ...T, apFreqsHz: [3200, 3300, 3400], apQs: [8, 8, 8] }
  assert.throws(() => new HFSoftenerKernel(SR, slow), /group delay/)
})

test('rotator: detector trim level-matches the follower on pink noise', () => {
  // Without the trim, switching the rotator moves the effective threshold by
  // ~0.5 dB and the rotator seems to do more than it does.
  const trim = Math.pow(10, ROTATOR_DETECTOR_TRIM_DB / 20)
  for (const sr of [44100, 48000, 96000]) {
    const x = pink(sr * 10)
    const meanDb = rot => {
      const rs = rotatorSections(sr).map(c => new Biquad(c))
      const hp = new Biquad(highpass(sr, T.detHpFreqHz, T.detHpQ))
      const f = new Follower(sr, T.attackMs, HF_SOFTENER_KERNEL_DEFAULTS.releaseMs)
      let sum = 0
      let cnt = 0
      for (let i = 0; i < x.length; i++) {
        let v = x[i]
        if (rot) for (const b of rs) v = b.tick(v)
        const e = f.tick(Math.abs(hp.tick(v)) * (rot ? trim : 1))
        if (i > sr) {
          sum += 20 * Math.log10(e + 1e-20)
          cnt++
        }
      }
      return sum / cnt
    }
    const d = meanDb(true) - meanDb(false)
    assert.ok(Math.abs(d) < 0.15, `residual ${d.toFixed(3)} dB at ${sr}`)
  }
})

test('rotator: lowers detector crest factor on impulsive content, not on fricative noise', () => {
  // ⚠ THE SPEC'S 3–5 dB IS NOT WHAT THIS MEASURES. On a glottal pulse train the
  // rotator takes ~2.4 dB off the detector's crest factor; on a fricative —
  // band-limited noise, already random-phase — it ADDS ~1 dB, because an
  // all-pass cannot make noise less peaky. Pinned so a real-speech evaluation
  // starts from the measured numbers rather than the theory. The spec expects
  // Module A may not earn its place; this is the first data point for that.
  const crest = (x, rot) => {
    const rs = rotatorSections(SR).map(c => new Biquad(c))
    const hp = new Biquad(highpass(SR, T.detHpFreqHz, T.detHpQ))
    let ss = 0, pk = 0, n = 0
    for (let i = 0; i < x.length; i++) {
      let v = x[i]
      if (rot) for (const b of rs) v = b.tick(v)
      v = hp.tick(v)
      if (i > SR * 0.05) {
        ss += v * v
        n++
        pk = Math.max(pk, Math.abs(v))
      }
    }
    return 20 * Math.log10(pk / Math.sqrt(ss / n))
  }
  const pulses = new Float32Array(SR * 2)
  const lp = new Biquad(lowpass(SR, 6000, 0.7))
  for (let i = 0; i < pulses.length; i++) pulses[i] = lp.tick(i % 400 === 0 ? 0.9 : 0)
  const pulseGain = crest(pulses, false) - crest(pulses, true)
  assert.ok(pulseGain > 1.5, `pulse-train crest reduction ${pulseGain.toFixed(2)} dB`)

  const rnd = lcg(7)
  const fric = new Float32Array(SR * 4)
  const h = new Biquad(highpass(SR, 4500, 0.7))
  const l = new Biquad(lowpass(SR, 9000, 0.7))
  for (let i = 0; i < fric.length; i++) {
    const t = (i % (SR / 4)) / SR
    fric[i] = l.tick(h.tick(rnd())) * (t < 0.03 ? Math.min(1, t / 0.002) : 0) * 0.5
  }
  const fricGain = crest(fric, false) - crest(fric, true)
  assert.ok(fricGain < 1, `fricative crest reduction ${fricGain.toFixed(2)} dB — the rotator now helps on noise; update the note`)
})

// ── Module B ────────────────────────────────────────────────────────────────

test('gain computer: zero below the knee, over/R above it, capped at D_max', () => {
  const R = 3, D = 6, K = 6, Tdb = -34
  assert.equal(gainComputerDb(-60, Tdb, R, D, K), 0)
  assert.equal(gainComputerDb(Tdb - K, Tdb, R, D, K), 0)
  assert.ok(Math.abs(gainComputerDb(Tdb + 9, Tdb, R, D, K) - -3) < 1e-12)
  assert.equal(gainComputerDb(0, Tdb, R, D, K), -6)
  // Continuous in value and slope at both knee edges — no threshold cliff.
  for (const edge of [-K, K]) {
    const e = 1e-6
    const lo = gainComputerDb(Tdb + edge - e, Tdb, R, 100, K)
    const hi = gainComputerDb(Tdb + edge + e, Tdb, R, 100, K)
    assert.ok(Math.abs(hi - lo) < 1e-5)
    const slopeLo = (lo - gainComputerDb(Tdb + edge - 1e-3, Tdb, R, 100, K)) / (1e-3 - e)
    const slopeHi = (gainComputerDb(Tdb + edge + 1e-3, Tdb, R, 100, K) - hi) / (1e-3 - e)
    assert.ok(Math.abs(slopeHi - slopeLo) < 1e-3, `slope jumps at ${edge}: ${slopeLo} vs ${slopeHi}`)
  }
})

test('amount macro: 0 % never engages; threshold, ratio and depth are linear to -44 dBFS / 6:1 / 24 dB', () => {
  assert.equal(amountToThresholdDb(0), 0)
  assert.equal(amountToMaxDepthDb(0), 0)
  assert.ok(Math.abs(amountToThresholdDb(1) - -44) < 1e-9)
  assert.ok(Math.abs(amountToMaxDepthDb(1) - 24) < 1e-9)
  assert.ok(Math.abs(amountToCompressionRatio(1) - 6) < 1e-9)
  assert.ok(Math.abs(amountToCompressionRatio(0) - 1) < 1e-9)
  // Linear: equal steps of the knob give equal steps of each quantity.
  const step = f => [0.2, 0.4, 0.6, 0.8].map(a => f(a + 0.2) - f(a))
  for (const f of [amountToThresholdDb, amountToMaxDepthDb, amountToCompressionRatio]) {
    const d = step(f)
    for (const v of d) assert.ok(Math.abs(v - d[0]) < 1e-9, `${f.name} is not linear: ${d}`)
  }
  assert.ok(Math.abs(contextToKappa(0.5) - 0.4) < 1e-12)
})

test('bit-transparent below threshold', () => {
  // The shelf at 0 dB has identical numerator and denominator, so quiet
  // material comes back sample-for-sample, not merely close.
  const x = pink(SR * 2, 9).map(v => v * 0.01)
  const { channelData } = processHFSoftenerBuffer([x], SR, {})
  for (let i = 0; i < x.length; i++) assert.equal(channelData[0][i], x[i], `sample ${i}`)
})

test('zero latency', () => {
  const x = new Float32Array(1024)
  x[100] = 0.001
  const { channelData } = processHFSoftenerBuffer([x], SR, {})
  assert.equal(channelData[0][100], x[100])
  assert.equal(channelData[0][99], 0)
})

test('breath and room tone get 0 dB of reduction; sibilants do not', () => {
  const { x, labels } = makeSpeech(SR)
  const { gainDb } = processHFSoftenerBuffer([x], SR, {}, { recordGain: true })
  let breathMin = 0
  let sibMin = 0
  for (let i = 0; i < x.length; i++) {
    if (labels[i] === 3) breathMin = Math.min(breathMin, gainDb[i])
    if (labels[i] === 2) sibMin = Math.min(sibMin, gainDb[i])
  }
  assert.equal(Math.abs(breathMin), 0, `breath reduced by ${-breathMin} dB`)
  assert.ok(sibMin < -2 && sibMin >= -6, `sibilant reduction ${sibMin.toFixed(2)} dB`)
})

test('gain-reduction histogram: mode at 0 dB, a tail and not a second peak', () => {
  const { x } = makeSpeech(SR)
  const { gainDb } = processHFSoftenerBuffer([x], SR, {}, { recordGain: true })
  const bins = new Array(13).fill(0) // 0.5 dB bins, 0 to -6
  for (const g of gainDb) bins[Math.min(12, Math.floor(-g / 0.5))]++
  const mode = bins.indexOf(Math.max(...bins))
  assert.equal(mode, 0, `histogram mode at bin ${mode}: ${bins.join(',')}`)
  assert.ok(bins[0] / gainDb.length > 0.6, `only ${(bins[0] / gainDb.length).toFixed(2)} of the time at 0 dB`)
  // No bin past the first holds more than a quarter of the first.
  for (let b = 1; b < bins.length; b++) {
    assert.ok(bins[b] < bins[0] / 4, `second peak at bin ${b}: ${bins.join(',')}`)
  }
})

// ── Module C ────────────────────────────────────────────────────────────────

test('adaptive threshold only ever rises, and by at most M', () => {
  assert.equal(adaptiveThresholdDb(-34, -60, 0.8, -20, 8), -34)
  assert.equal(adaptiveThresholdDb(-34, 0, 0.8, -20, 8), -26)
  assert.ok(Math.abs(adaptiveThresholdDb(-34, -10, 0.4, -20, 8) - -30) < 1e-12)
  assert.equal(adaptiveThresholdDb(-34, 0, 0, -20, 8), -34)
})

test('context: an isolated sibilant is cut harder than one inside a phrase', () => {
  const { x } = makeSpeech(SR)
  const worst = (gainDb, a, b) => {
    let m = 0
    for (let i = 0; i < x.length; i++) {
      const t = (i % SR) / SR
      if (i > SR && t >= a && t < b) m = Math.min(m, gainDb[i])
    }
    return m
  }
  const fixed = processHFSoftenerBuffer([x], SR, { context: 0 }, { recordGain: true }).gainDb
  const ctx = processHFSoftenerBuffer([x], SR, { context: 0.5 }, { recordGain: true }).gainDb
  const inPhraseFixed = worst(fixed, 0.35, 0.45)
  const inPhraseCtx = worst(ctx, 0.35, 0.45)
  const isolatedCtx = worst(ctx, 0.7, 0.8)
  assert.ok(inPhraseCtx > inPhraseFixed + 0.3, `context did not relax the in-phrase sibilant: ${inPhraseFixed} → ${inPhraseCtx}`)
  assert.ok(isolatedCtx < inPhraseCtx - 0.1, `isolated ${isolatedCtx} vs in-phrase ${inPhraseCtx}`)
})

// ── Implementation ──────────────────────────────────────────────────────────

test('sample-rate invariance: same stimulus at 44.1 / 48 / 96 kHz, same gain curve', () => {
  // A stimulus defined in continuous time: a 6.5 kHz tone burst over a 300 Hz
  // tone. Gain is compared at matching instants.
  const curve = sr => {
    const n = Math.round(sr * 0.6)
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const burst = t > 0.2 && t < 0.24 ? 0.2 : 0
      x[i] = 0.1 * Math.sin(2 * Math.PI * 300 * t) + burst * Math.sin(2 * Math.PI * 6500 * t)
    }
    return processHFSoftenerBuffer([x], sr, { amount: 0.6 }, { recordGain: true }).gainDb
  }
  const ref = curve(48000)
  for (const sr of [44100, 96000]) {
    const g = curve(sr)
    let worst = 0
    for (let ms = 150; ms < 500; ms += 1) {
      const a = ref[Math.round((ms / 1000) * 48000)]
      const b = g[Math.round((ms / 1000) * sr)]
      worst = Math.max(worst, Math.abs(a - b))
    }
    assert.ok(worst < 0.25, `gain curve differs by ${worst.toFixed(3)} dB at ${sr}`)
  }
})

test('delta monitor is exactly what the processor removed', () => {
  const { x } = makeSpeech(SR, { seconds: 2 })
  const wet = processHFSoftenerBuffer([x], SR, {}).channelData[0]
  const delta = processHFSoftenerBuffer([x], SR, {}, { listen: 'delta' }).channelData[0]
  let worst = 0
  for (let i = 0; i < x.length; i++) worst = Math.max(worst, Math.abs(wet[i] + delta[i] - x[i]))
  assert.ok(worst < 1e-6, `wet + delta misses the input by ${worst}`)
})

test('in-path rotation changes phase only while the shelf is idle', () => {
  const x = pink(SR, 4).map(v => v * 0.01)
  const out = processHFSoftenerBuffer([x], SR, { rotator: 'inpath' }).channelData[0]
  const rs = rotatorSections(SR).map(c => new Biquad(c))
  let worst = 0
  for (let i = 0; i < x.length; i++) {
    let v = x[i]
    for (const b of rs) v = b.tick(v)
    worst = Math.max(worst, Math.abs(out[i] - v))
  }
  assert.ok(worst < 1e-7, `in-path output is not the rotated input: ${worst}`)
})

test('stereo is linked: identical channels give the mono result on both', () => {
  const { x } = makeSpeech(SR, { seconds: 2 })
  const mono = processHFSoftenerBuffer([x], SR, {}).channelData[0]
  const [l, r] = processHFSoftenerBuffer([x, x], SR, {}).channelData
  for (let i = 0; i < x.length; i++) {
    assert.equal(l[i], mono[i])
    assert.equal(r[i], mono[i])
  }
})

test('pre-roll converges an applied region onto the playing preview', () => {
  const { x } = makeSpeech(SR, { seconds: 4 })
  const full = processHFSoftenerBuffer([x], SR, {}).channelData[0]
  const pre = Math.round(HF_SOFTENER_PREROLL_S * SR)
  const start = Math.round(2.3 * SR) // mid-vowel, envelopes live
  const cut = processHFSoftenerBuffer([x.subarray(start - pre)], SR, {}).channelData[0]
  let worst = 0
  for (let i = 0; i < SR; i++) worst = Math.max(worst, Math.abs(cut[pre + i] - full[start + i]))
  assert.ok(20 * Math.log10(worst + 1e-30) < -90, `region differs by ${(20 * Math.log10(worst)).toFixed(1)} dBFS`)
})

test('macro changes ramp rather than step', () => {
  const k = new HFSoftenerKernel(SR)
  k.setParams({ amount: 1 })
  // Half-way through the 20 ms ramp the threshold is between the two ends.
  const n = Math.round(0.01 * SR)
  const buf = new Float32Array(n)
  k.process([buf], [new Float32Array(n)], n)
  const v = k.tBase.value
  assert.ok(v < -34 && v > -44, `threshold after 10 ms: ${v}`)
})

test('shelf curve helper matches the depth range', () => {
  const [lo, hi] = magnitudeResponseDb([shelfSection(SR, -6)], [200, 16000], SR)
  assert.ok(Math.abs(lo) < 0.1, `shelf moves the low end by ${lo}`)
  assert.ok(Math.abs(hi - -6) < 0.2, `shelf plateau ${hi}`)
})

// ── Release, vowel release, band shape ──────────────────────────────────────

/** "s", 25 ms closure, "s", 20 ms, "s" — a fast consonant run with no vowel. */
function consonantRun(sr) {
  const rnd = lcg(11)
  const n = sr * 3
  const y = new Float32Array(n)
  const h = new Biquad(highpass(sr, 5000, 0.7))
  const l = new Biquad(lowpass(sr, 9000, 0.7))
  const bursts = [[0.3, 0.34], [0.365, 0.405], [0.425, 0.465]]
  for (let i = 0; i < n; i++) {
    const t = (i % sr) / sr
    const v = l.tick(h.tick(rnd()))
    if (bursts.some(([a, b]) => t >= a && t < b)) y[i] = v * 0.22
    if (t < 0.3 || t > 0.5) y[i] += 0.06 * Math.sin(2 * Math.PI * 130 * i / sr)
  }
  return { y, bursts }
}

/** Largest recovery (dB) of the shelf inside the run's unvoiced gaps. */
function gapBounceDb(params) {
  const { y, bursts } = consonantRun(SR)
  const g = processHFSoftenerBuffer([y], SR, params, { recordGain: true }).gainDb
  let worst = 0
  for (let c = 1; c < 3; c++) {
    for (let j = 0; j < 2; j++) {
      const a = Math.round((c + bursts[j][1]) * SR)
      const b = Math.round((c + bursts[j + 1][0]) * SR)
      let hi = -99
      for (let i = a; i < b; i++) hi = Math.max(hi, g[i])
      let before = 0
      for (let i = a - Math.round(0.01 * SR); i < a; i++) before = Math.min(before, g[i])
      worst = Math.max(worst, hi - before)
    }
  }
  return worst
}

function meanGain(gainDb, a, b) {
  let s = 0, n = 0
  for (let i = SR; i < gainDb.length; i++) {
    const t = (i % SR) / SR
    if (t >= a && t < b) { s += gainDb[i]; n++ }
  }
  return s / n
}

test('vowel release: the vowel after an "s" keeps its top end', () => {
  // The dulling that remained after sibilants was release carryover into the
  // next vowel, not the vowels themselves — measured -1.32 dB over its first
  // 60 ms at the default, -3.59 at Amount 80 %.
  const { x } = makeSpeech(SR)
  for (const amount of [0.4, 0.8]) {
    const off = processHFSoftenerBuffer([x], SR, { amount, vowelRelease: false }, { recordGain: true }).gainDb
    const on = processHFSoftenerBuffer([x], SR, { amount, vowelRelease: true }, { recordGain: true }).gainDb
    const carryOff = meanGain(off, 0.39, 0.45)
    const carryOn = meanGain(on, 0.39, 0.45)
    // At the shipped 40 % / 40 ms: -1.93 → -0.77 dB. At least halved.
    assert.ok(carryOn > carryOff * 0.5, `amount ${amount}: carryover ${carryOff.toFixed(2)} → ${carryOn.toFixed(2)} dB`)
    // …without giving up the sibilants themselves.
    for (const [a, b] of [[0.35, 0.39], [0.7, 0.735]]) {
      // Relative: above the default the ratio steepens and the cuts scale.
      const base = meanGain(off, a, b)
      const d = meanGain(on, a, b) - base
      assert.ok(d < 0.1 * -base, `amount ${amount}: sibilant at ${a} s lost ${d.toFixed(2)} of ${(-base).toFixed(2)} dB`)
    }
  }
})

test('vowel release does not bring back chatter inside a consonant run', () => {
  const off = gapBounceDb({ vowelRelease: false })
  const on = gapBounceDb({ vowelRelease: true })
  assert.ok(Math.abs(on - off) < 0.05, `gap bounce ${off.toFixed(2)} → ${on.toFixed(2)} dB`)
})

test('release: longer holds steadier through a consonant run', () => {
  const fast = gapBounceDb({ releaseMs: 30 })
  const slow = gapBounceDb({ releaseMs: 120 })
  assert.ok(slow < fast - 0.5, `bounce at 30 ms ${fast.toFixed(2)}, at 120 ms ${slow.toFixed(2)}`)
})

test('band shape: cuts the sibilance band, leaves the air above 16 kHz, never boosts', () => {
  for (const sr of [44100, 48000, 96000]) {
    for (const depth of [3, 6, 9, 12, 18, 24]) {
      const secs = softenerSections(sr, -depth, 'band')
      const dense = Array.from({ length: 400 }, (_, i) => 100 * Math.pow(10, (i / 399) * Math.log10(0.49 * sr / 100)))
      const db = magnitudeResponseDb(secs, dense, sr)
      const deepest = Math.min(...db)
      // 0.09 dB at 6 dB of depth, 0.32–0.35 at the 24 dB maximum.
      assert.ok(Math.max(...db) < 0.02 * depth + 0.05, `boost ${Math.max(...db).toFixed(2)} dB at ${sr}/${depth}`)
      // The compensation is solved per rate, so the depth lands everywhere.
      assert.ok(Math.abs(deepest + depth) < 0.1, `deepest ${deepest.toFixed(2)} for ${depth} dB at ${sr}`)
      const [air] = magnitudeResponseDb(secs, [16000], sr)
      const [shelfAir] = magnitudeResponseDb(softenerSections(sr, -depth, 'shelf'), [16000], sr)
      // Near-flat at 44.1/48 kHz; the shelves' shapes differ at 96 kHz and the
      // band reaches higher there (16 kHz −2.9 dB at 12 dB of depth).
      assert.ok(air > -(sr > 48000 ? 0.25 : 0.1) * depth, `16 kHz cut ${air.toFixed(2)} dB at ${sr}/${depth}`)
      assert.ok(shelfAir < -0.9 * depth, 'the shelf is the one that takes the air')
    }
  }
})

test('both shapes are exact identities at 0 dB', () => {
  for (const shape of ['shelf', 'band']) {
    for (const c of softenerSections(SR, 0, shape)) {
      assert.ok(c.b0 === 1 || Math.abs(c.b0 - 1) < 1e-15)
      assert.ok(Math.abs(c.b1 - c.a1) < 1e-15 && Math.abs(c.b2 - c.a2) < 1e-15)
    }
    const x = pink(SR, 5).map(v => v * 0.01)
    const { channelData } = processHFSoftenerBuffer([x], SR, { shape })
    for (let i = 0; i < x.length; i++) assert.equal(channelData[0][i], x[i], `${shape} sample ${i}`)
  }
})

// ── Level alignment ─────────────────────────────────────────────────────────

test('level alignment: a hotter file with its measured offset gets the same gain curve', () => {
  // Every detector level moves dB-for-dB with the offset and the detector is
  // linear, so the curve is invariant — not approximately, to rounding.
  const { x } = makeSpeech(SR, { seconds: 3 })
  const ref = processHFSoftenerBuffer([x], SR, { levelOffsetDb: 0 }, { recordGain: true }).gainDb
  for (const db of [-12, 9]) {
    const k = Math.pow(10, db / 20)
    const y = x.map(v => v * k)
    const g = processHFSoftenerBuffer([y], SR, { levelOffsetDb: db }, { recordGain: true }).gainDb
    let worst = 0
    for (let i = 0; i < g.length; i++) worst = Math.max(worst, Math.abs(g[i] - ref[i]))
    assert.ok(worst < 1e-3, `${db} dB: gain curve moved by ${worst.toFixed(5)} dB`)
    // And without the offset it would not have been: the premise of the fix.
    // Guard off: the guard is voice-relative, so it is level-invariant by
    // itself and would hide what the alignment is for.
    const raw = processHFSoftenerBuffer([y], SR, { lispGuard: false }, { recordGain: true }).gainDb
    let drift = 0
    for (let i = 0; i < g.length; i++) drift = Math.max(drift, Math.abs(raw[i] - ref[i]))
    assert.ok(drift > 1, `${db} dB: an unaligned file only moved ${drift.toFixed(2)} dB`)
  }
})

test('level alignment: offset is gated RMS minus nominal, clamped', () => {
  assert.equal(levelOffsetDbFor(-20), 0)
  assert.equal(levelOffsetDbFor(-26), -6)
  assert.equal(levelOffsetDbFor(0), 20)
  assert.equal(levelOffsetDbFor(30), 24)
  assert.equal(levelOffsetDbFor(-80), -24)
  assert.equal(levelOffsetDbFor(-Infinity), 0)
})

test('level alignment: Amount 0 % never engages, even on a very quiet file', () => {
  const { x } = makeSpeech(SR, { seconds: 2 })
  const { gainDb } = processHFSoftenerBuffer([x], SR, { amount: 0, levelOffsetDb: -24 }, { recordGain: true })
  for (const g of gainDb) assert.equal(Math.abs(g), 0)
})

// ── Amount-driven ratio ─────────────────────────────────────────────────────

test('ratio: 1:1 at 0 %, 2:1 at the 20 % default, 6:1 at 100 %', () => {
  assert.equal(amountToSlope(0), 0)
  assert.ok(Math.abs(amountToCompressionRatio(0.2) - 2) < 1e-9)
  assert.ok(Math.abs(amountToSlope(1) - 5 / 6) < 1e-12)
})

test('amount: the cut grows in even steps across the dial', () => {
  // The two earlier maps front-loaded the threshold and back-loaded the
  // ratio: per-10 % cuts ran -0.2 … -15.6 with each step bigger than the last.
  const { x, labels } = makeSpeech(SR, { seconds: 3 })
  const deepest = a => {
    // The MAP's evenness, so guard off — the guard deliberately flattens the
    // top of the knob on well-behaved sibilants (see the lisp-guard tests).
    const { gainDb } = processHFSoftenerBuffer([x], SR, { amount: a, lispGuard: false }, { recordGain: true })
    let m = 0, breath = 0
    for (let i = 0; i < gainDb.length; i++) {
      m = Math.min(m, gainDb[i])
      if (labels[i] === 3) breath = Math.min(breath, gainDb[i])
    }
    return { m, breath }
  }
  const cuts = [0.2, 0.4, 0.6, 0.8, 1].map(a => deepest(a).m)
  const steps = cuts.map((c, i) => (i === 0 ? c : c - cuts[i - 1]))
  const mean = cuts[cuts.length - 1] / cuts.length
  for (const s of steps) {
    assert.ok(Math.abs(s - mean) < 0.35 * Math.abs(mean), `uneven steps: ${steps.map(v => v.toFixed(2))}`)
  }
  // The default keeps the old default's cut; the top still digs.
  assert.ok(cuts[0] > -3.6 && cuts[0] < -2.4, `default reached ${cuts[0].toFixed(2)} dB`)
  assert.ok(cuts[4] < -12, `Amount 100 % only reached ${cuts[4].toFixed(2)} dB`)
  assert.ok(deepest(1).breath > -1, 'breath touched at Amount 100 %')
})

// ── Lisp guard ──────────────────────────────────────────────────────────────

test('lisp guard: a normal "s" stops getting deeper, a hot one is still chased', () => {
  // Measured: normal sibilants 20/40/60/80/100 % -> -2.8 -5.8 -6.7 -6.7 -6.7
  // with the guard, -2.8 -5.8 -9.0 -12.1 -15.3 without. The default is
  // untouched on the peak; the top of the knob no longer digs into a normal
  // "s", which is exactly the lisp it exists to stop.
  const { x } = makeSpeech(SR, { seconds: 3 })
  const deepest = (a, guard, y = x) => {
    const { gainDb } = processHFSoftenerBuffer([y], SR, { amount: a, lispGuard: guard }, { recordGain: true })
    let m = 0
    for (const v of gainDb) m = Math.min(m, v)
    return m
  }
  assert.ok(Math.abs(deepest(0.4, true) - deepest(0.4, false)) < 0.2, 'guard moved the default')
  const g100 = deepest(1, true)
  assert.ok(g100 > -8, `guard let a normal "s" go to ${g100.toFixed(2)} dB`)
  assert.ok(deepest(1, false) < g100 - 5, 'the unguarded map should dig much deeper')
  // A hotter "s" clears the floor by more, so it may still be cut hard.
  const hot = x.map(v => v * 1.0)
  const k = Math.pow(10, 12 / 20)
  // Scale only the sibilant spans.
  for (let i = 0; i < hot.length; i++) {
    const t = (i % SR) / SR
    if ((t >= 0.35 && t < 0.39) || (t >= 0.7 && t < 0.735)) hot[i] = x[i] * k
  }
  assert.ok(deepest(1, true, hot) < g100 - 6, 'a hot "s" should still be cut much deeper than a normal one')
})

test('lisp guard: the cut lets go as the next vowel starts', () => {
  // The voice level jumps with the vowel, the "s" no longer clears the floor,
  // and the cap drops to zero — carryover removed by construction.
  const { x } = makeSpeech(SR)
  const post = guard => {
    const { gainDb } = processHFSoftenerBuffer([x], SR, { amount: 1, lispGuard: guard }, { recordGain: true })
    return meanGain(gainDb, 0.39, 0.45)
  }
  const off = post(false)
  const on = post(true)
  assert.ok(on > off * 0.5, `post-"s" vowel ${off.toFixed(2)} -> ${on.toFixed(2)} dB`)
})

// ── HF RESO pre-stage ───────────────────────────────────────────────────────

test('reso pre-stage: 5–12 kHz only, 512-sample frame', () => {
  const p = hfResoKernelParams()
  assert.equal(HF_RESO_FRAME_SIZE, 512)
  assert.equal(HF_RESO_LATENCY_SAMPLES, HF_RESO_FRAME_SIZE)
  const on = HF_RESO_ZONES.filter(z => z.enabled)
  assert.equal(on.length, 1)
  assert.equal(on[0].hiHz, 12000)
  assert.equal(HF_RESO_ZONES[0].hiHz, 5000)
  // Survives a structured clone (it crosses into the worklet).
  assert.deepEqual(structuredClone(p), p)
})

test('reso pre-stage: takes a ring, leaves an ordinary S and the air to the softener', () => {
  const sr = 44100
  const { x: clean, labels } = makeSpeech(sr, { seconds: 4 })
  // A 7.5 kHz ring excited by the voice, riding its envelope.
  const env = new Float32Array(clean.length)
  for (let i = 0, e = 0; i < clean.length; i++) { e = Math.max(Math.abs(clean[i]), e * 0.9995); env[i] = e }
  const ringed = clean.map((v, i) => v + 0.02 * env[i] * Math.sin(2 * Math.PI * 7500 * i / sr))

  const run = (x) => {
    const r = processResonanceBuffer([x], sr, hfResoKernelParams(), { frameSize: HF_RESO_FRAME_SIZE })
    assert.equal(r.latencySamples, HF_RESO_LATENCY_SAMPLES)
    const o = new Float32Array(x.length)
    o.set(r.channelData[0].subarray(r.latencySamples))
    return o
  }
  const bandDb = (y, sections, mask) => {
    const fs = sections.map(c => new Biquad(c))
    let s = 0
    for (let i = 0; i < y.length; i++) {
      let v = y[i]
      for (const f of fs) v = f.tick(v)
      if (i > sr && i < y.length - sr / 10 && (!mask || mask(i))) s += v * v
    }
    return 10 * Math.log10(s + 1e-30)
  }
  const ring = [bandpass(sr, 7500, 30), bandpass(sr, 7500, 30)]
  const sib = [highpass(sr, 5000, 0.7), highpass(sr, 5000, 0.7), lowpass(sr, 9000, 0.7), lowpass(sr, 9000, 0.7)]
  const air = [highpass(sr, 13000, 0.7), highpass(sr, 13000, 0.7)]

  const yRing = run(ringed)
  const yClean = run(clean)
  const ringCut = bandDb(yRing, ring) - bandDb(ringed, ring)
  const sibCut = bandDb(yClean, sib, i => labels[i] === 2) - bandDb(clean, sib, i => labels[i] === 2)
  const airCut = bandDb(yClean, air) - bandDb(clean, air)
  assert.ok(ringCut < -12, `ring cut ${ringCut.toFixed(2)} dB`)
  assert.ok(Math.abs(sibCut) < 0.25, `ordinary S moved ${sibCut.toFixed(2)} dB`)
  assert.ok(Math.abs(airCut) < 0.1, `air moved ${airCut.toFixed(2)} dB`)
})
