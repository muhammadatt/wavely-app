import test from 'node:test'
import assert from 'node:assert/strict'
import {
  measureSpeechLevelDb,
  SPEECH_LEVEL_PERCENTILE,
} from '../../src/audio/staticThreshold.js'
import {
  processSoftClipperBuffer,
  SoftClipperKernel,
  SOFT_CLIPPER_KERNEL_DEFAULTS,
} from '../../src/audio/softClipperProcessor.js'
import { SOFT_CLIPPER_DEFAULTS, toKernelParams } from '../../src/audio/effects/softClipperParams.js'

const SR = 48000
const db = v => 20 * Math.log10(v + 1e-300)

/**
 * Speech-shaped probe with raised-cosine edges — a hard gate splatters
 * broadband energy that no real recording has, and the tracker's own gate reads
 * it as signal.
 */
function speech(seconds, levelDb, sampleRate = SR) {
  const n = Math.round(seconds * sampleRate)
  const x = new Float32Array(n)
  const amp = Math.pow(10, levelDb / 20)
  const syl = Math.round(0.18 * sampleRate)
  const edge = Math.round(0.012 * sampleRate)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const phase = i % Math.round(0.30 * sampleRate)
    let env = 0
    if (phase < syl) {
      env = 1
      if (phase < edge) env = 0.5 - 0.5 * Math.cos((Math.PI * phase) / edge)
      else if (phase > syl - edge) env = 0.5 - 0.5 * Math.cos((Math.PI * (syl - phase)) / edge)
    }
    // Two harmonics plus a little breath, so the detector sees something with
    // a real crest rather than a sine.
    x[i] = amp * env * (
      0.7 * Math.sin(2 * Math.PI * 130 * t) +
      0.3 * Math.sin(2 * Math.PI * 390 * t) +
      0.05 * Math.sin(2 * Math.PI * 4300 * t)
    )
  }
  return x
}

test('the measurement is level-invariant — that is the whole point of keeping it', () => {
  // Static mode exists to keep Headroom meaning the same thing on a quiet file
  // and a loud one. If the measurement does not track level exactly, it buys
  // nothing over a threshold typed in dBFS.
  const base = measureSpeechLevelDb([speech(6, -12)], SR)
  assert.ok(base !== null)
  for (const shift of [-18, -6, 6]) {
    const moved = measureSpeechLevelDb([speech(6, -12 + shift)], SR)
    assert.ok(Math.abs(moved - (base + shift)) < 0.15,
      `${shift} dB shift moved the measurement by ${(moved - base).toFixed(3)} dB`)
  }
})

test('warm-up readings never reach the percentile — the sentinel is 0 dBFS', () => {
  // For its first 500 ms the tracker is parked at SPEECH_INIT_HOLD_DB = 0, the
  // loudest value in the distribution. On a SHORT selection those blocks are a
  // large share of the total, so a percentile that included them would return
  // roughly 0 dBFS and the threshold would land ~60 dB too high.
  const quiet = measureSpeechLevelDb([speech(1.2, -30)], SR)
  assert.ok(quiet !== null, 'a 1.2 s selection should still measure')
  assert.ok(quiet < -20, `warm-up leaked into the percentile: ${quiet.toFixed(2)} dBFS`)
  // And the long-file answer agrees with the short-file one, which it could not
  // if the sentinel were diluting the short one.
  const long = measureSpeechLevelDb([speech(8, -30)], SR)
  assert.ok(Math.abs(long - quiet) < 2.0,
    `short ${quiet.toFixed(2)} vs long ${long.toFixed(2)} dBFS`)
})

test('too short or too quiet returns null rather than a meaningless number', () => {
  assert.equal(measureSpeechLevelDb([new Float32Array(0)], SR), null)
  assert.equal(measureSpeechLevelDb([new Float32Array(SR)], SR), null, 'digital silence')
  // Shorter than the tracker's own warm-up: nothing survives the exclusion.
  assert.equal(measureSpeechLevelDb([speech(0.3, -12)], SR), null)
})

test('the percentile is high, not median — and which one is a knob', () => {
  assert.equal(SPEECH_LEVEL_PERCENTILE, 0.90)
  const x = [speech(8, -12)]
  const p50 = measureSpeechLevelDb(x, SR, { percentile: 0.5 })
  const p90 = measureSpeechLevelDb(x, SR, { percentile: 0.9 })
  assert.ok(p90 > p50, `p90 ${p90.toFixed(2)} should exceed p50 ${p50.toFixed(2)}`)
})

test('static mode holds the threshold still where adaptive moves it', () => {
  // Read the kernel's own per-block threshold. With the emphasis lift and the
  // hysteresis memory both out of the way, static mode's T must be EXACTLY
  // constant — anything else means something is still feeding the tracker in.
  const sig = speech(8, -12)
  const trajectory = params => {
    const k = new SoftClipperKernel(SR)
    k.setParams({ emphasisDb: 0, hysteresis: 0, limiter: 0, ...params })
    const B = 128, out = [new Float32Array(B)], v = []
    for (let off = 0; off + B <= sig.length; off += B) {
      k.process([sig.subarray(off, off + B)], out, B)
      if (off > SR) v.push(db(k.scopeThreshold))
    }
    return v
  }
  const level = measureSpeechLevelDb([sig], SR)
  const stat = trajectory({ thresholdMode: 'static', staticSpeechLevelDb: level })
  const adapt = trajectory({ thresholdMode: 'adaptive' })

  const range = v => Math.max(...v) - Math.min(...v)
  assert.ok(range(stat) < 1e-6, `static threshold moved ${range(stat).toFixed(4)} dB`)
  assert.ok(range(adapt) > 0.5, `adaptive should move; it moved ${range(adapt).toFixed(4)} dB`)
})

test('Headroom keeps its meaning — static T is the measured level plus the knob', () => {
  const sig = speech(8, -12)
  const level = measureSpeechLevelDb([sig], SR)
  for (const headroomDb of [5, 8, 12]) {
    const k = new SoftClipperKernel(SR)
    k.setParams({ emphasisDb: 0, hysteresis: 0, limiter: 0, headroomDb, thresholdMode: 'static', staticSpeechLevelDb: level })
    const B = 128, out = [new Float32Array(B)]
    for (let off = 0; off + B <= sig.length; off += B) k.process([sig.subarray(off, off + B)], out, B)
    assert.ok(Math.abs(db(k.scopeThreshold) - (level + headroomDb)) < 0.05,
      `Headroom ${headroomDb}: T ${db(k.scopeThreshold).toFixed(3)} vs expected ${(level + headroomDb).toFixed(3)}`)
  }
})

test('a missing measurement falls back to adaptive rather than rendering against nothing', () => {
  // The failure this prevents is silent and severe: `null + headroom` is NaN,
  // and a NaN threshold would take the whole stage with it.
  const sig = speech(6, -12)
  const render = params => processSoftClipperBuffer([sig], SR, params).channelData[0]
  const adaptive = render({})
  for (const bad of [null, undefined, NaN]) {
    const y = render({ thresholdMode: 'static', staticSpeechLevelDb: bad })
    for (let i = 0; i < y.length; i++) {
      assert.ok(Number.isFinite(y[i]), `staticSpeechLevelDb ${bad} produced a non-finite sample`)
      assert.equal(y[i], adaptive[i])
    }
  }
})

test('the param contract carries staticSpeechLevelDb to the kernel', () => {
  // Both halves matter. The key must survive setParam's `name in params` guard
  // (it is inherited from the kernel defaults), and toKernelParams must forward
  // it — drop either and static mode degrades to adaptive with nothing said.
  assert.ok('staticSpeechLevelDb' in SOFT_CLIPPER_DEFAULTS)
  assert.equal(SOFT_CLIPPER_KERNEL_DEFAULTS.staticSpeechLevelDb, null)
  const forwarded = toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, staticSpeechLevelDb: -14.25 })
  assert.equal(forwarded.staticSpeechLevelDb, -14.25)
  assert.equal(forwarded.thresholdMode, 'adaptive')
})

test('the shipped default is untouched by all of this', () => {
  // staticSpeechLevelDb defaults to null and thresholdMode to adaptive, so the
  // default patch must be bit-identical to the build before static mode existed.
  const sig = speech(6, -12)
  const a = processSoftClipperBuffer([sig], SR, {}).channelData[0]
  const b = processSoftClipperBuffer([sig], SR, { ...SOFT_CLIPPER_KERNEL_DEFAULTS }).channelData[0]
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i])
})
