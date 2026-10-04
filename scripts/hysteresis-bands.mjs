/**
 * Hysteresis on the Saturation Bench: low band vs 20 Hz–4 kHz vs full band,
 * rendered on a real narration and measured for what the choice is about —
 * does it soften onsets, what does it do per band, how much does it compress
 * loud against quiet, and what does it cost.
 *
 *   node scripts/hysteresis-bands.mjs <narration.wav> [outDir|-] [driveDb,...] [c=0.6,K=5]
 *
 * One layer, FULL mode, no emphasis, Amount 0 (so with alpha 1 the layer is
 * the curve run in series on its band). Drive is the bench's: 0 dB is 1 % THD
 * on a sine at the band's reference peak, so each band is calibrated to its own
 * level on this file. Renders are written as 32-bit float WAVs with the
 * latency trimmed, beside a dry copy, for A/B.
 */
import { performance } from 'node:perf_hooks'
import { readWav, writeFloatWav } from './lib/wav.js'
import { processSaturationBenchBuffer, SAT_BENCH_LAYER_LATENCY } from '../src/audio/dsp/saturationLayers.js'
import { measureBandSpectrum, bandRefPeakDb } from '../src/audio/saturationBenchAnalysis.js'
import { BiquadCascade, highpass, lowpass } from '../src/audio/dsp/biquad.js'
import { setHysteresisShape, hysteresisShape, hysteresisSineResponse, hysteresisSmallGain } from '../src/audio/dsp/hysteresis.js'

const [, , path, outDir, drivesArg, shapeArg] = process.argv
// Optional shape override, e.g. c=0.85,K=5 — sweeps the model, never the app.
if (shapeArg) setHysteresisShape(Object.fromEntries(shapeArg.split(',').map(kv => { const [k, v] = kv.split('='); return [k, Number(v)] })))
if (!path) { console.error('usage: node scripts/hysteresis-bands.mjs <narration.wav> [outDir] [driveDb,...]'); process.exit(1) }
const drives = (drivesArg ?? '6,12,18').split(',').map(Number)
// CURVE=tanh runs a memoryless curve through the same measurement, for comparison.
const CURVE = process.env.CURVE || 'hysteresis'
const { mono: x, sampleRate: sr } = readWav(path)
const BANDS = [
  { id: 'low', label: 'low band 1–250 Hz', loHz: 1, hiHz: 250 },
  { id: 'mid', label: '20 Hz–4 kHz', loHz: 20, hiHz: 4000 },
  { id: 'full', label: 'full band', loHz: 1, hiHz: 20000 },
]
const seg = [{ outputStart: 0, sourceStart: 0, sourceEnd: x.length / sr, sourceBuffer: { numberOfChannels: 1, getChannelData: () => x } }]
const spectrum = measureBandSpectrum(seg, 0, x.length / sr, sr, 1)

const db = v => 20 * Math.log10(Math.max(v, 1e-12))
const rmsOf = (y, a = 0, b = y.length) => { let s = 0; for (let i = a; i < b; i++) s += y[i] * y[i]; return Math.sqrt(s / Math.max(1, b - a)) }
const peakOf = y => { let m = 0; for (const v of y) m = Math.max(m, Math.abs(v)); return m }
function filt(y, lo, hi) {
  const secs = []
  if (lo) secs.push(highpass(sr, lo), highpass(sr, lo))
  if (hi) secs.push(lowpass(sr, hi), lowpass(sr, hi))
  const c = new BiquadCascade(secs.length, 1); c.setSections(secs)
  const out = new Float64Array(y.length); c.process(y, out, y.length, 0); return out
}

// ── Onsets: the 10 ms envelope rising 6 dB within 30 ms into loud speech ─────
const W = Math.round(0.010 * sr)
const env = []
for (let i = 0; i + W <= x.length; i += W) env.push(rmsOf(x, i, i + W))
const loud = [...env].sort((a, b) => a - b)[Math.floor(env.length * 0.95)]
const onsets = []
for (let k = 5; k < env.length - 15; k++) {
  const before = Math.min(...env.slice(Math.max(0, k - 3), k))
  if (db(env[k]) - db(before) > 6 && db(env[k]) > db(loud) - 25 && (onsets.length === 0 || k - onsets.at(-1) > 8)) onsets.push(k)
}
// Frames for loud-vs-quiet: 50 ms, voiced = within 30 dB of the 95th percentile.
const F = Math.round(0.05 * sr)
const frames = []
for (let i = 0; i + F <= x.length; i += F) frames.push(i)
const fr = frames.map(i => rmsOf(x, i, i + F))
const fLoud = [...fr].sort((a, b) => a - b)[Math.floor(fr.length * 0.95)]
const voiced = frames.map((i, j) => ({ i, r: fr[j] })).filter(f => db(f.r) > db(fLoud) - 30).sort((a, b) => a.r - b.r)
const q = Math.floor(voiced.length / 4)
const quietF = voiced.slice(0, q), loudF = voiced.slice(-q)

const MBANDS = [[20, 250], [250, 1000], [1000, 4000], [4000, 10000], [10000, null]]
const xb = MBANDS.map(([l, h]) => filt(x, l, h))

function measure(y) {
  // y is aligned to x.
  const bands = MBANDS.map(([l, h], j) => db(rmsOf(filt(y, l, h)) / rmsOf(xb[j])))
  const frameDelta = list => db(Math.sqrt(list.reduce((s, f) => s + rmsOf(y, f.i, f.i + F) ** 2, 0) / list.reduce((s, f) => s + rmsOf(x, f.i, f.i + F) ** 2, 0)))
  // Onset: peak of the first 20 ms against the level 40–150 ms in, change vs dry.
  let soft = 0
  const on = onsets.map(k => k * W)
  for (const i of on) {
    const crest = s => db(peakOf(s.subarray(i, i + Math.round(0.02 * sr))) / rmsOf(s, i + Math.round(0.04 * sr), i + Math.round(0.15 * sr)))
    soft += crest(y) - crest(x)
  }
  return {
    peak: db(peakOf(y) / peakOf(x)),
    rms: db(rmsOf(y) / rmsOf(x)),
    onsetCrest: soft / on.length,
    loud: frameDelta(loudF),
    quiet: frameDelta(quietF),
    bands,
  }
}

const f = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
console.log(`${path.split('/').pop()}: ${(x.length / sr).toFixed(1)} s, ${onsets.length} onsets, ${voiced.length} voiced frames`)
console.log('bands measured: 20–250 / 250–1k / 1–4k / 4–10k / 10k+ (output − input, dB)\n')
{
  const sh = hysteresisShape()
  const loop = hysteresisSineResponse(2, { scale: 1 / hysteresisSmallGain() })
  console.log(`shape c ${sh.c} K ${sh.K} A ${sh.A}: on a sine at 2× calibration ${(20 * Math.log10(loop.gain)).toFixed(2)} dB, ${(loop.thd * 100).toFixed(1)} % THD, ${loop.lagDeg.toFixed(1)}° lag\n`)
}
if (outDir && outDir !== '-') writeFloatWav(`${outDir}/hysteresis_dry.wav`, x, sr)
for (const b of BANDS) {
  const refPeakDb = bandRefPeakDb(spectrum, b.loHz, b.hiHz)
  console.log(`── ${b.label}  (band reference peak ${refPeakDb.toFixed(1)} dBFS)`)
  for (const d of drives) {
    const t = performance.now()
    const { channelData: [yr], latencySamples: L } = processSaturationBenchBuffer([x], sr, {
      layers: [{ on: true, curve: CURVE, driveDb: d, mode: 'full', emphDb: 0, loHz: b.loHz, hiHz: b.hiHz, refPeakDb }],
    }, { slots: 1 })
    const ms = performance.now() - t
    const y = new Float32Array(x.length)
    y.set(yr.subarray(L))
    const m = measure(y)
    console.log(`  drive ${f(d)}  peak ${f(m.peak)}  rms ${f(m.rms)}  onset crest ${f(m.onsetCrest)}  loud ${f(m.loud)} quiet ${f(m.quiet)} (compression ${f(m.quiet - m.loud)})  bands ${m.bands.map(f).join(' / ')}  ${((x.length / sr) * 1000 / ms).toFixed(0)}x realtime`)
    if (outDir && outDir !== '-') writeFloatWav(`${outDir}/${CURVE}_${b.id}_drive${d}.wav`, y, sr)
  }
}
