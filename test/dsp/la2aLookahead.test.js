/**
 * Run with:  npm test
 *
 * OptoSmooth's optional lookahead. See LOOKAHEAD_MAX_MS in la2aProcessor.js for
 * what it is for and what it costs; these tests pin the four claims the feature
 * rests on, each of which fails silently if it stops being true.
 *
 *   1. It is OFF by default and off is bit-identical to the build before it.
 *   2. It does not touch the model — the gain envelope is identical at every
 *      depth, and only its alignment to the audio moves. This is the claim that
 *      makes "the character is preserved" a fact rather than a hope.
 *   3. The reported latency follows it, through both the getter and the
 *      standalone function the apply path sizes its render from.
 *   4. It does the job: it raises the peak-referenced auto makeup, because a
 *      transient met by the gain the cell would have reached later no longer
 *      sets the file's peak on its own.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LA2AKernel,
  processLA2ABuffer,
  computeAutoMakeupDb,
  la2aLatencySamples,
  LOOKAHEAD_MAX_MS,
  LA2A_KERNEL_DEFAULTS,
} from '../../src/audio/la2aProcessor.js'
import { OVERSAMPLE_LATENCY_SAMPLES } from '../../src/audio/dsp/oversample.js'
import {
  LA2A_DEFAULTS, toKernelParams, la2aPatchLatencySamples, LA2A_LATENCY_SAMPLES,
} from '../../src/audio/effects/la2aParams.js'
import { SchepsKernel, SCHEPS_KERNEL_DEFAULTS } from '../../src/audio/schepsProcessor.js'

const SR = 44100
const BLOCK = 128

/**
 * Speech-like material with HARD ONSETS OUT OF SILENCE, which is the only thing
 * this feature is about. A smooth syllabic envelope would not exercise it: the
 * T4's 10 ms attack keeps up with anything slower, and every assertion below
 * would pass for the wrong reason.
 */
function onsets(seconds = 4, peak = 0.8) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let seed = 12345
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  let t = 0.25
  while (t < seconds - 0.3) {
    const dur = 0.09 + rnd() * 0.1
    const amp = 0.35 + rnd() * 0.5
    const f0 = 105 + rnd() * 70
    const s0 = Math.round(t * SR)
    const s1 = Math.min(n, Math.round((t + dur) * SR))
    for (let i = s0; i < s1; i++) {
      const u = (i - s0) / SR
      // ~2 ms onset: fast enough that the cell is still opening when it lands.
      const env = Math.min(1, u / 0.002) * Math.exp(-u / (dur * 0.7))
      let v = 0
      for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * u) / h
      x[i] += amp * env * v * 0.35
    }
    // A gap long enough for the fast release stage to open the cell back up.
    t += dur + 0.12 + rnd() * 0.12
  }
  let max = 0
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(x[i]))
  for (let i = 0; i < n; i++) x[i] *= peak / max
  return x
}

const peak = (ch) => {
  let m = 0
  for (const v of ch) m = Math.max(m, Math.abs(v))
  return m
}
const rms = (ch, from = 0) => {
  let s = 0
  for (let i = from; i < ch.length; i++) s += ch[i] * ch[i]
  return Math.sqrt(s / (ch.length - from))
}
const db = (v) => 20 * Math.log10(Math.max(v, 1e-30))

/** Run a kernel block by block, capturing the per-block gain-reduction trace. */
function runWithTrace(channels, params) {
  const k = new LA2AKernel(SR)
  k.setParams(params)
  const n = channels[0].length
  const out = channels.map(() => new Float32Array(n))
  const trace = []
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    k.process(
      channels.map((c) => c.subarray(off, off + len)),
      out.map((c) => c.subarray(off, off + len)),
      len,
    )
    trace.push(k.grDb)
  }
  return { out, trace }
}

// ── 1. Off by default, and off means unchanged ──────────────────────────────

test('lookahead is off by default, in the kernel and in the panel', () => {
  assert.equal(LA2A_KERNEL_DEFAULTS.lookaheadMs, 0)
  assert.equal(LA2A_DEFAULTS.lookahead, 0)
  assert.equal(toKernelParams(LA2A_DEFAULTS).lookaheadMs, 0)
})

test('lookahead 0 is bit-identical to not naming the parameter at all', () => {
  const x = [onsets()]
  const base = { peakReduction: 65, gainDb: 4 }
  const a = processLA2ABuffer(x, SR, base).channelData[0]
  const b = processLA2ABuffer(x, SR, { ...base, lookaheadMs: 0 }).channelData[0]
  assert.deepEqual(Array.from(a), Array.from(b))
  assert.equal(la2aLatencySamples(base, SR), OVERSAMPLE_LATENCY_SAMPLES)
})

// ── 2. The model is untouched; only the alignment moves ─────────────────────

test('the gain envelope is identical at every lookahead depth', () => {
  // THE LOAD-BEARING TEST. Lookahead delays the AUDIO; the side-chain, the
  // static curve, the T4 ballistics and the LDR memory all still run on the
  // undelayed input. If a future change routes the delayed copy into the
  // detector, the compressor silently becomes a different instrument and every
  // preset shifts under the user — so the envelope is compared exactly, not
  // approximately.
  const x = [onsets()]
  const reference = runWithTrace(x, { peakReduction: 70 }).trace
  for (const lookaheadMs of [1, 5, 10, LOOKAHEAD_MAX_MS]) {
    const { trace } = runWithTrace(x, { peakReduction: 70, lookaheadMs })
    assert.deepEqual(trace, reference, `envelope moved at ${lookaheadMs} ms`)
  }
})

test('the audio is delayed by exactly the reported lookahead', () => {
  // An impulse through a bypassed cell: with no reduction to apply, the only
  // thing the plugin does to it is delay it. Measured against the oversampled
  // path's own latency so this stays a test of the lookahead alone.
  const n = SR
  const x = [new Float32Array(n)]
  x[0][1000] = 0.5
  for (const lookaheadMs of [0, 5, 10, LOOKAHEAD_MAX_MS]) {
    const params = { peakReduction: 0, tube: false, lookaheadMs }
    const { channelData, latencySamples } = processLA2ABuffer(x, SR, params)
    let at = 0
    let m = 0
    for (let i = 0; i < n; i++) {
      const a = Math.abs(channelData[0][i])
      if (a > m) { m = a; at = i }
    }
    assert.equal(latencySamples, la2aLatencySamples(params, SR))
    assert.equal(at - 1000, latencySamples, `impulse misplaced at ${lookaheadMs} ms`)
  }
})

test('a reset clears the lookahead line, so no audio crosses a region change', () => {
  // Oversampling off, so the lookahead line is the ONLY thing here holding
  // audio: the halfband filters keep ~50 samples of history that `resetState`
  // deliberately does not clear, and including them would make this a test of
  // that instead.
  const k = new LA2AKernel(SR)
  k.setParams({ peakReduction: 0, tube: false, oversample: false, lookaheadMs: 10 })
  const loud = [new Float32Array(BLOCK).fill(0.9)]
  const sink = [new Float32Array(BLOCK)]
  for (let i = 0; i < 8; i++) k.process(loud, sink, BLOCK)

  k.resetState()
  // Silence in. Anything that comes out is the previous region's tail.
  const silence = [new Float32Array(BLOCK)]
  const out = [new Float32Array(BLOCK)]
  const lookaheadSamples = Math.round((10 / 1000) * SR)
  let leaked = 0
  for (let i = 0; i * BLOCK < lookaheadSamples + BLOCK; i++) {
    k.process(silence, out, BLOCK)
    leaked = Math.max(leaked, peak(out[0]))
  }
  assert.ok(leaked < 1e-6, `previous region leaked through at ${leaked}`)
})

// ── 3. Latency plumbing ─────────────────────────────────────────────────────

test('la2aLatencySamples mirrors the kernel getter exactly', () => {
  // The apply path sizes its OfflineAudioContext from the function, before any
  // node exists, and trims the render by it. The two drifting apart splices the
  // region in shifted, with that much of its tail dropped — silently.
  for (const sr of [44100, 48000, 96000]) {
    for (const lookaheadMs of [0, 1, 3.5, 10, LOOKAHEAD_MAX_MS]) {
      const params = { peakReduction: 50, lookaheadMs }
      const k = new LA2AKernel(sr)
      k.setParams(params)
      assert.equal(k.latencySamples, la2aLatencySamples(params, sr),
        `mismatch at ${sr} Hz, ${lookaheadMs} ms`)
    }
  }
})

test('lookahead is clamped to the ceiling, in both the kernel and the function', () => {
  const over = { lookaheadMs: LOOKAHEAD_MAX_MS + 50 }
  const at = { lookaheadMs: LOOKAHEAD_MAX_MS }
  assert.equal(la2aLatencySamples(over, SR), la2aLatencySamples(at, SR))
  const a = new LA2AKernel(SR); a.setParams(over)
  const b = new LA2AKernel(SR); b.setParams(at)
  assert.equal(a.latencySamples, b.latencySamples)
  // And a negative or junk value falls back to off rather than to a delay line
  // of negative length.
  for (const bad of [-5, NaN, undefined, null, 'x']) {
    assert.equal(la2aLatencySamples({ lookaheadMs: bad }, SR), OVERSAMPLE_LATENCY_SAMPLES)
    const k = new LA2AKernel(SR)
    k.setParams({ lookaheadMs: bad })
    assert.equal(k.latencySamples, OVERSAMPLE_LATENCY_SAMPLES)
  }
})

test('the panel-facing latency follows the panel param, and the constant is its floor', () => {
  assert.equal(la2aPatchLatencySamples(LA2A_DEFAULTS, SR), LA2A_LATENCY_SAMPLES)
  assert.equal(
    la2aPatchLatencySamples({ ...LA2A_DEFAULTS, lookahead: 10 }, SR),
    LA2A_LATENCY_SAMPLES + Math.round(0.010 * SR),
  )
  assert.ok(la2aPatchLatencySamples({ ...LA2A_DEFAULTS, lookahead: LOOKAHEAD_MAX_MS }, SR)
    > LA2A_LATENCY_SAMPLES)
})

test('Scheps pins lookahead off, so its latency constant stays true', () => {
  // SCHEPS_LATENCY_SAMPLES is a constant and the apply path trims by it. The
  // composite inherits the LA-2A kernel, so a lookahead default that ever
  // reached it would make that constant wrong without a word. Scheps could
  // reasonably want the control — this test is what makes adding it a
  // deliberate act rather than an accident.
  // Compared against OVERSAMPLE_LATENCY_SAMPLES rather than imported, because
  // `effects/scheps.js` pulls a worklet loader Node cannot resolve — but that
  // is exactly what `SCHEPS_LATENCY_SAMPLES` is defined as, so this pins the
  // same number.
  const k = new SchepsKernel(SR)
  k.setParams(SCHEPS_KERNEL_DEFAULTS)
  assert.equal(k.latencySamples, OVERSAMPLE_LATENCY_SAMPLES)
  assert.equal(k.la2a.lookaheadSamples, 0)
})

// ── 4. It does the job ──────────────────────────────────────────────────────

test('lookahead raises the peak-referenced auto makeup, monotonically', () => {
  const x = [onsets()]
  const at = (lookaheadMs) =>
    computeAutoMakeupDb(x, SR, { peakReduction: 70, lookaheadMs })

  const off = at(0)
  const depths = [3, 5, 10, LOOKAHEAD_MAX_MS].map((ms) => at(ms))
  let prev = off
  for (const [i, v] of depths.entries()) {
    assert.ok(v > prev - 1e-6, `makeup fell going deeper (step ${i}: ${prev} -> ${v})`)
    prev = v
  }
  // Not merely monotone — worth something. On this material the ceiling buys
  // several dB the compressor was otherwise throwing away.
  assert.ok(prev - off > 2, `only ${(prev - off).toFixed(2)} dB recovered`)
})

test('with lookahead the compressor stops expanding crest factor', () => {
  // THE REPORTED BUG, as a test. Peak-matched makeup on transient-rich material
  // left the output QUIETER and MORE dynamic than the source, because one
  // un-compressed onset set the peak the makeup was referenced to.
  const x = [onsets()]
  const inCrest = db(peak(x[0])) - db(rms(x[0]))

  const crestAfter = (lookaheadMs) => {
    const params = { peakReduction: 70, lookaheadMs }
    const gainDb = computeAutoMakeupDb(x, SR, params)
    const { channelData, latencySamples } = processLA2ABuffer(x, SR, { ...params, gainDb })
    // Skip the render's own latency: those samples are the filters and the
    // delay line filling, not signal, and they would flatter the rms.
    const y = channelData[0].subarray(latencySamples)
    return db(peak(y)) - db(rms(y))
  }

  const off = crestAfter(0)
  const on = crestAfter(LOOKAHEAD_MAX_MS)
  assert.ok(off > inCrest, `the premise no longer holds: crest ${inCrest} -> ${off}`)
  assert.ok(on < off, `lookahead did not reduce crest expansion (${off} -> ${on})`)
  // At the ceiling the expansion should be largely gone rather than merely
  // dented — it is what the control is sold on.
  assert.ok(on - inCrest < (off - inCrest) / 2,
    `expansion only fell from ${(off - inCrest).toFixed(2)} to ${(on - inCrest).toFixed(2)} dB`)
})

test('the makeup solve measures the span apply writes back, not the raw render', () => {
  // With lookahead the output lags, so the last `latency` samples of a region
  // never emerge. Measuring the render as-is compares a region's input peak
  // against an output missing that region's tail. On a short selection whose
  // peak IS in the tail, that reads the wrong peak and the makeup comes out
  // wrong — which is exactly the shape of selection a spot edit makes.
  const n = Math.round(0.25 * SR)
  const x = [new Float32Array(n)]
  for (let i = 0; i < n; i++) x[0][i] = 0.2 * Math.sin(2 * Math.PI * 220 * i / SR)
  // The loudest moment sits inside the final 20 ms — the part a naive
  // measurement would never see.
  for (let i = n - Math.round(0.012 * SR); i < n; i++) x[0][i] *= 4

  const params = { peakReduction: 70, lookaheadMs: LOOKAHEAD_MAX_MS, oversample: false }
  const makeup = computeAutoMakeupDb(x, SR, params)
  // Extended then trimmed, which is what `applyWorkletRegion` does — the whole
  // region only emerges if the render is given `latency` more samples to push
  // it out with.
  const latency = la2aLatencySamples(params, SR)
  const padded = x.map((ch) => {
    const p = new Float32Array(ch.length + latency)
    p.set(ch, 0)
    return p
  })
  const { channelData, latencySamples } = processLA2ABuffer(
    padded, SR, { ...params, gainDb: makeup },
  )
  assert.equal(latencySamples, latency)
  // Applied over the span apply keeps, the peak must land back on the input's
  // — which is what peak-referenced makeup promises and what a tail-blind
  // measurement would miss by several dB.
  const applied = channelData[0].subarray(latencySamples, latencySamples + n)
  assert.ok(Math.abs(db(peak(applied)) - db(peak(x[0]))) < 0.3,
    `peak not restored: ${db(peak(x[0])).toFixed(2)} -> ${db(peak(applied)).toFixed(2)} dB`)
})
