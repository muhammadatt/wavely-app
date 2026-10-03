/**
 * HF Limiter — the Warmth readout (src/audio/hfLimiterWarmthReadout.js).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { measureWarmthReadout, renderWarmthAligned, WARMTH_READOUT_BANDS } from '../../src/audio/hfLimiterWarmthReadout.js'
import { processHFLimiterBuffer } from '../../src/audio/hfLimiterProcessor.js'
import { toKernelParams, warmthLayers } from '../../src/audio/hfLimiterParams.js'

const SR = 44100
const REFS = [-12, -13]

/** A low-voiced stack with a syllable envelope and a little noise, ~3 s. */
function voice(seconds = 3) {
  const n = Math.round(SR * seconds)
  const x = new Float32Array(n)
  let s = 7
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647
    const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 3 * i) / SR)
    let v = 0
    for (let h = 1; h <= 12; h++) v += Math.sin((2 * Math.PI * 130 * h * i) / SR) / h
    x[i] = 0.2 * env * v + 0.003 * ((s / 2147483647) * 2 - 1)
  }
  return x
}

const peakDb = chs => {
  let m = 0
  for (const c of chs) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]))
  return 20 * Math.log10(m)
}

test('Warmth 0 reads no change in any band, and the input peak', () => {
  const x = voice()
  const r = measureWarmthReadout([x], SR, warmthLayers(0, 0, REFS))
  assert.equal(r.bandsDb.length, WARMTH_READOUT_BANDS.length)
  for (const d of r.bandsDb) assert.ok(Math.abs(d) < 1e-9, `band ${d}`)
  assert.ok(Math.abs(r.peakDb - peakDb([x])) < 1e-9)
  // The source's own peak comes back too, so the panel can print the change: 0 here.
  assert.ok(Math.abs(r.inputPeakDb - peakDb([x])) < 1e-9)
  assert.ok(Math.abs(r.peakDb - r.inputPeakDb) < 1e-9)
})

test('the render is aligned to the input: Warmth 0 is the input, sample for sample', () => {
  const x = voice(1)
  const [y] = renderWarmthAligned([x], SR, warmthLayers(0, 0, REFS))
  assert.equal(y.length, x.length)
  for (let i = 0; i < x.length; i++) if (y[i] !== x[i]) assert.fail(`sample ${i}: ${y[i]} vs ${x[i]}`)
})

test('the readout moves the low end and reports the stage peak the plugin delivers', () => {
  const x = voice()
  const p = { odd: 8, even: 2.3, warmthRefPeaksDb: REFS, range: 0 }
  const r = measureWarmthReadout([x], SR, toKernelParams(p).warmthLayers)
  assert.ok(r.bandsDb.some(d => Math.abs(d) > 1), `bands ${r.bandsDb}`)
  // With the shelf out the plugin IS the stage, so their peaks agree...
  const full = processHFLimiterBuffer([x], SR, toKernelParams(p))
  assert.ok(Math.abs(peakDb(full.channelData) - r.peakDb) < 1e-3, `plugin ${peakDb(full.channelData)} vs readout ${r.peakDb}`)
  // ...and with the shelf in, the readout is an upper bound.
  const shelf = processHFLimiterBuffer([x], SR, toKernelParams({ ...p, range: 24, threshold: -20 }))
  assert.ok(peakDb(shelf.channelData) <= r.peakDb + 1e-3, `shelf ${peakDb(shelf.channelData)} over ${r.peakDb}`)
})

test('bands only or peak only, on request', () => {
  const x = voice(1)
  const layers = warmthLayers(5, 5, REFS)
  assert.equal(measureWarmthReadout([x], SR, layers, { bands: false }).bandsDb, null)
  assert.equal(measureWarmthReadout([x], SR, layers, { peak: false }).peakDb, null)
  // Too short to resolve the low bands: no band figures rather than wrong ones.
  assert.equal(measureWarmthReadout([x.subarray(0, 2000)], SR, layers).bandsDb, null)
})

test('the loudness change is what AUTO takes back: applied, the stage lands at the input loudness', async () => {
  const { measureIntegratedLufs } = await import('../../src/audio/dsp/loudness.js')
  const x = voice()
  assert.ok(Math.abs(measureWarmthReadout([x], SR, warmthLayers(0, 0, REFS)).loudnessDeltaDb) < 1e-9)
  const p = { odd: 8, even: 2.3, warmthRefPeaksDb: REFS, range: 0 }
  const r = measureWarmthReadout([x], SR, toKernelParams(p).warmthLayers)
  assert.ok(Math.abs(r.loudnessDeltaDb) > 0.5, `Odd 8 / Even 2.3 moved loudness ${r.loudnessDeltaDb} LU`)
  const auto = processHFLimiterBuffer([x], SR, toKernelParams({ ...p, warmthMakeup: 'loud', warmthMakeupDb: -r.loudnessDeltaDb }))
  const L = auto.latencySamples
  const y = auto.channelData[0].subarray(L)
  const lin = measureIntegratedLufs([x.subarray(0, y.length)], SR)
  const lout = measureIntegratedLufs([y], SR)
  assert.ok(Math.abs(lout - lin) < 0.05, `AUTO lands ${(lout - lin).toFixed(3)} LU off the input`)
})

test('PEAK makeup: the readout peak change, taken back, puts the peak where the source had it', () => {
  // Pure Even lifts the waveform, so a negative-going peak comes DOWN: the case PEAK exists for.
  const x = voice()
  for (let i = 0; i < x.length; i++) x[i] = -x[i]
  const p = { odd: 0, even: 3, warmthRefPeaksDb: REFS, range: 0 }
  const r = measureWarmthReadout([x], SR, toKernelParams(p).warmthLayers)
  const makeup = r.inputPeakDb - r.peakDb
  const out = processHFLimiterBuffer([x], SR, toKernelParams({ ...p, warmthMakeup: 'peak', warmthMakeupDb: makeup }))
  const got = peakDb([out.channelData[0].subarray(out.latencySamples)])
  assert.ok(Math.abs(got - r.inputPeakDb) < 0.01, `peak ${got.toFixed(3)} vs source ${r.inputPeakDb.toFixed(3)} (makeup ${makeup.toFixed(2)})`)
  // OFF ignores a measured makeup.
  assert.equal(toKernelParams({ ...p, warmthMakeup: 'off', warmthMakeupDb: makeup }).warmthMakeupDb, 0)
})

test('the readout renders the guard: with it on, the peak change is never above zero', () => {
  const x = voice()
  const src = peakDb([x])
  const p = { odd: 10, even: 4, warmthRefPeaksDb: REFS, warmthCeilingDb: src, range: 0 }
  const k = toKernelParams({ ...p, warmthGuard: true })
  const open = measureWarmthReadout([x], SR, toKernelParams(p).warmthLayers)
  const held = measureWarmthReadout([x], SR, k.warmthLayers, { guard: k.warmthGuard })
  assert.ok(open.peakDb > src + 0.5, `the fixture must overshoot: ${(open.peakDb - src).toFixed(2)} dB`)
  assert.ok(held.peakDb <= src + 1e-5, `guarded readout peak ${(held.peakDb - src).toFixed(4)} dB over the source`)
  // ...and it is what the plugin delivers (shelf out).
  const full = processHFLimiterBuffer([x], SR, k)
  const y = full.channelData[0].subarray(full.latencySamples)
  assert.ok(Math.abs(peakDb([y]) - held.peakDb) < 1e-3, `plugin ${peakDb([y])} vs readout ${held.peakDb}`)
})
