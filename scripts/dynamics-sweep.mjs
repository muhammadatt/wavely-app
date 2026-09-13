#!/usr/bin/env node
/**
 * DENSITY SWEEP FEASIBILITY BENCH.
 *
 *   npm run dynamics:sweep -- path/to/narration.wav
 *
 * Does a sampled Density SWEEP reproduce the per-Density bisect solve?
 *
 * The solve bisects two knobs per Density move (~8 kernel renders each, ~7.7 s
 * total). If the two curves can be sampled ONCE and interpolated, Density
 * becomes a lookup and the knob goes live.
 *
 *   Clipper: threshold -> crest.  Measured on the RAW input, so it does not
 *            depend on Density at all — Density only picks the target.
 *   FET:     drive -> impact.     Measured on the CLIPPED signal, so it is a
 *            function of TWO variables and this is the part in question.
 */
import { readWav } from '../test/voicerx/wav.js'
import { SoftClipperKernel } from '../src/audio/softClipperProcessor.js'
import { FET1176Kernel } from '../src/audio/fet1176Processor.js'
import {
  clipParamsFor, fetParamsFor, DYNAMICS_KERNEL_DEFAULTS,
} from '../src/audio/dynamicsProcessor.js'
import { inputAlignDbFor } from '../src/audio/dsp/inputAlign.js'
import {
  measureDynamics, solveDynamics, VOICINGS, CLIP_MAX_DEPTH_DB,
} from '../src/audio/dynamicsSolve.js'

const SOLVE_RENDER = { oversample: false }
const PATCH = { ...DYNAMICS_KERNEL_DEFAULTS, ...SOLVE_RENDER }

function runKernel(kernel, channels) {
  const out = channels.map(c => new Float32Array(c.length))
  const n = channels[0].length
  for (let off = 0; off < n; off += 128) {
    const len = Math.min(128, n - off)
    kernel.process(
      channels.map(c => c.subarray(off, off + len)),
      out.map(c => c.subarray(off, off + len)), len)
  }
  return out
}
const renderClip = (ch, sr, p) => {
  const k = new SoftClipperKernel(sr); k.setParams(clipParamsFor({ ...PATCH, ...p }))
  return { out: runKernel(k, ch), metering: k.getMetering() }
}
const renderFet = (ch, sr, p) => {
  const k = new FET1176Kernel(sr); k.setParams(fetParamsFor({ ...PATCH, ...p }))
  return { out: runKernel(k, ch), metering: k.getMetering() }
}

const { mono, sampleRate, seconds } = readWav(process.argv[2])
const WIN = Math.round(Math.min(30, seconds) * sampleRate)
const x = [mono.subarray(0, WIN)]
const input = measureDynamics(x, sampleRate)
const voicing = VOICINGS.audiobook
console.log(`window ${(WIN / sampleRate).toFixed(1)} s @ ${sampleRate}`)
console.log(`input  peak ${input.peakDb.toFixed(2)}  crest ${input.crestDb.toFixed(2)}  impact ${input.impactDb.toFixed(2)}\n`)

const DENSITIES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

// ── 1. Ground truth: the shipping solve, per Density ────────────────────────
const truth = []
let tTruth = 0
for (const d of DENSITIES) {
  const t = performance.now()
  const { params } = solveDynamics(x, sampleRate, { density: d, voicing: 'audiobook' })
  tTruth += performance.now() - t
  truth.push({ d, clipThresholdDb: params.clipThresholdDb, fetDrive: params.fetDrive })
}

// ── 2. The sweep: sample each curve once ────────────────────────────────────
const N = 12
const lerp = (xs, ys, xq) => {
  if (xq <= xs[0]) return ys[0]
  if (xq >= xs[xs.length - 1]) return ys[ys.length - 1]
  for (let i = 1; i < xs.length; i++) {
    if (xq <= xs[i]) {
      const t = (xq - xs[i - 1]) / (xs[i] - xs[i - 1])
      return ys[i - 1] + t * (ys[i] - ys[i - 1])
    }
  }
  return ys[ys.length - 1]
}
// invert a decreasing y(x) sampled at xs: find x for target y
const invert = (xs, ys, target) => {
  // ys decreasing in x
  if (target >= ys[0]) return xs[0]
  if (target <= ys[ys.length - 1]) return xs[xs.length - 1]
  for (let i = 1; i < xs.length; i++) {
    if (target >= ys[i]) {
      const t = (ys[i - 1] - target) / (ys[i - 1] - ys[i])
      return xs[i - 1] + t * (xs[i] - xs[i - 1])
    }
  }
  return xs[xs.length - 1]
}

const tSweep0 = performance.now()
// 2a. Clipper curve on the RAW input — Density-independent.
const thresholds = []
const clipCrest = []
const clipDepth = []
const clipImpact = []
const clipAlign = []
for (let i = 0; i < N; i++) {
  const th = input.peakDb - 24 + (24 * i) / (N - 1)
  const r = renderClip(x, sampleRate, { clipThresholdDb: th })
  const m = measureDynamics(r.out, sampleRate)
  thresholds.push(th)
  clipCrest.push(m.crestDb)
  clipDepth.push(r.metering.maxReductionDb)
  // ⚠ SAMPLED TOO, so a Density move needs NO render at all. Re-rendering the
  // clipper just to read its post-clip impact costs ~600 ms, which is not a
  // live knob either.
  clipImpact.push(m.impactDb)
  clipAlign.push(inputAlignDbFor(r.out, sampleRate))
}
// thresholds ascending -> crest ascending (less clipping). invert() wants
// decreasing, so mirror.
const thrRev = [...thresholds].reverse()
const crestRev = [...clipCrest].reverse()
const depthRev = [...clipDepth].reverse()

// 2b. FET curve, sampled at ONE clip setting: the mid of the macro's range.
const midDensity = 0.5
const midShave = Math.min(voicing.clipShaveDb * midDensity, CLIP_MAX_DEPTH_DB)
const midTh = invert(thrRev, crestRev, input.crestDb - midShave)
const midClip = renderClip(x, sampleRate, { clipThresholdDb: midTh }).out
const midAlign = inputAlignDbFor(midClip, sampleRate)
const drives = []
const fetImpact = []
for (let i = 0; i < N; i++) {
  const dr = (100 * i) / (N - 1)
  drives.push(dr)
  fetImpact.push(measureDynamics(
    renderFet(midClip, sampleRate, { fetDrive: dr, fetAlignDb: midAlign }).out,
    sampleRate).impactDb)
}
const tSweep = performance.now() - tSweep0

console.log(`sweep build: ${(tSweep / 1000).toFixed(2)} s  (${N} clip + ${N} FET renders)`)
console.log(`true solves: ${(tTruth / 1000).toFixed(2)} s for ${DENSITIES.length} densities `
  + `(${(tTruth / 1000 / DENSITIES.length).toFixed(2)} s each)\n`)

// ── 3. Reproduce each Density from the sweep, and score it ──────────────────
console.log('  D |  clip threshold dB  |      FET drive      |  achieved impact dB')
console.log('    |  true   sweep   err |  true   sweep   err |  true   sweep   err')
let maxThErr = 0, maxDrErr = 0, maxImpErr = 0
for (let i = 0; i < DENSITIES.length; i++) {
  const d = DENSITIES[i] / 100
  const t = truth[i]

  const wantShave = Math.min(voicing.clipShaveDb * d, CLIP_MAX_DEPTH_DB)
  /**
   * ⚠ ONE SEARCH AGAINST TWO CONSTRAINTS, exactly as the bisect has it. Both
   * crest and depth fall monotonically as the threshold drops, so the sweep has
   * to invert BOTH curves and take the SHALLOWER threshold — the cap is a hard
   * bound and the crest target is not. Leaving the cap out ran the inversion off
   * the end of the sampled range at Density 90+ and cost 1.32 dB of impact.
   */
  const thCrest = invert(thrRev, crestRev, input.crestDb - wantShave)
  const thDepth = invert(thrRev, depthRev.map(v => -v), -CLIP_MAX_DEPTH_DB)
  const sTh = Math.max(thCrest, thDepth)

  // PURE LOOKUP: no render anywhere in this block.
  const afterClipImpact = lerp(thresholds, clipImpact, sTh)
  const targetImpact = afterClipImpact - (afterClipImpact - voicing.impactDb) * d
  const sDr = invert(drives, fetImpact, targetImpact)

  // What each actually achieves, rendered through the real stages.
  const achieve = (th, dr) => {
    const c = renderClip(x, sampleRate, { clipThresholdDb: th }).out
    const a = inputAlignDbFor(c, sampleRate)
    return measureDynamics(
      renderFet(c, sampleRate, { fetDrive: dr, fetAlignDb: a }).out, sampleRate).impactDb
  }
  const tImp = achieve(t.clipThresholdDb, t.fetDrive)
  const sImp = achieve(sTh, sDr)

  const thErr = sTh - t.clipThresholdDb
  const drErr = sDr - t.fetDrive
  const impErr = sImp - tImp
  maxThErr = Math.max(maxThErr, Math.abs(thErr))
  maxDrErr = Math.max(maxDrErr, Math.abs(drErr))
  maxImpErr = Math.max(maxImpErr, Math.abs(impErr))
  console.log(`${String(DENSITIES[i]).padStart(4)}|`
    + `${t.clipThresholdDb.toFixed(2).padStart(7)}${sTh.toFixed(2).padStart(8)}`
    + `${thErr.toFixed(2).padStart(7)} |`
    + `${t.fetDrive.toFixed(1).padStart(6)}${sDr.toFixed(1).padStart(8)}`
    + `${drErr.toFixed(1).padStart(7)} |`
    + `${tImp.toFixed(2).padStart(7)}${sImp.toFixed(2).padStart(8)}`
    + `${impErr.toFixed(2).padStart(7)}`)
}
console.log(`\nmax |err|: threshold ${maxThErr.toFixed(3)} dB, `
  + `drive ${maxDrErr.toFixed(2)}, ACHIEVED IMPACT ${maxImpErr.toFixed(3)} dB`)
