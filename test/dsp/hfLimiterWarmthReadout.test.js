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
  const r = measureWarmthReadout([x], SR, warmthLayers(0, 50, REFS))
  assert.equal(r.bandsDb.length, WARMTH_READOUT_BANDS.length)
  for (const d of r.bandsDb) assert.ok(Math.abs(d) < 1e-9, `band ${d}`)
  assert.ok(Math.abs(r.peakDb - peakDb([x])) < 1e-9)
})

test('the render is aligned to the input: Warmth 0 is the input, sample for sample', () => {
  const x = voice(1)
  const [y] = renderWarmthAligned([x], SR, warmthLayers(0, 50, REFS))
  assert.equal(y.length, x.length)
  for (let i = 0; i < x.length; i++) if (y[i] !== x[i]) assert.fail(`sample ${i}: ${y[i]} vs ${x[i]}`)
})

test('the readout moves the low end and reports the stage peak the plugin delivers', () => {
  const x = voice()
  const p = { warmth: 8, oddEven: 9, warmthRefPeaksDb: REFS, range: 0 }
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
  const layers = warmthLayers(5, 50, REFS)
  assert.equal(measureWarmthReadout([x], SR, layers, { bands: false }).bandsDb, null)
  assert.equal(measureWarmthReadout([x], SR, layers, { peak: false }).peakDb, null)
  // Too short to resolve the low bands: no band figures rather than wrong ones.
  assert.equal(measureWarmthReadout([x.subarray(0, 2000)], SR, layers).bandsDb, null)
})
