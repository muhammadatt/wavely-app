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
  HF_SOFTENER_PREROLL_S,
  ROTATOR_DETECTOR_TRIM_DB,
  adaptiveThresholdDb,
  amountToMaxDepthDb,
  amountToThresholdDb,
  contextToKappa,
  gainComputerDb,
  processHFSoftenerBuffer,
  rotatorMaxGroupDelayMs,
  rotatorSections,
  shelfSection,
} from '../../src/audio/hfSoftenerProcessor.js'
import { highpass, lowpass, magnitudeResponseDb, peaking } from '../../src/audio/dsp/biquad.js'

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
      const f = new Follower(sr, T.attackMs, T.releaseMs)
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

test('amount macro: 0 % never engages, 40 % is the tuned default, 100 % is -44 dBFS / 9 dB', () => {
  assert.equal(amountToThresholdDb(0), 0)
  assert.equal(amountToMaxDepthDb(0), 0)
  assert.ok(Math.abs(amountToThresholdDb(0.4) - -34) < 1e-9)
  assert.ok(Math.abs(amountToMaxDepthDb(0.4) - 6) < 1e-9)
  assert.ok(Math.abs(amountToThresholdDb(1) - -44) < 1e-9)
  assert.ok(Math.abs(amountToMaxDepthDb(1) - 9) < 1e-9)
  for (let a = 0.05; a <= 1; a += 0.05) {
    assert.ok(amountToThresholdDb(a) < amountToThresholdDb(a - 0.05))
    assert.ok(amountToMaxDepthDb(a) > amountToMaxDepthDb(a - 0.05))
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
