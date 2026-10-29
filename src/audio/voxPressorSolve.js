/**
 * VoxPressor's per-file solves: what the Peaks and Body knobs MEAN on this
 * recording. See docs/voxpressor_spec.md §4.2 and §5.
 *
 * Neither compressor's knob is exposed. Each stage is driven by a detector-only
 * offset (`peaksAlignDb`, `bodyAlignDb` — the kernels' `inputAlignDb`), so the
 * audio gain through a stage never moves when a knob does, and each knob is a
 * TARGET this module solves for:
 *
 * - PEAKS (dB) — how far the 1176 takes the loudest peaks down: the median,
 *   over the loudest blocks, of each block's input peak minus its output peak.
 *   The solve always goes where the knob asks; what it costs the voice is
 *   MEASURED (`peaksBodyDb`, the median level drop on the voiced blocks) and
 *   reported, and the panel warns past `PEAKS_BODY_WARN_DB`. See that constant
 *   for the fixed floor this replaced.
 * - BODY (dB) — the LA-2A's average gain reduction over the voiced blocks of
 *   what the Peaks stage left.
 * - MAKEUP — the gain that puts the output's GATED LEVEL back on the input's
 *   (`gatedRmsOfChannels`, the input-alignment gate), paired with a soft
 *   ceiling at the source's own peak. The makeup is the last multiply before
 *   the ceiling, so the output is affine in it and ONE render answers it in
 *   closed form — the LA Classic 76 case, not the LA-2A one.
 *
 * ⚠ NOT THE COMPRESSORS' SHARED 99.9th-PERCENTILE REFERENCE, AND THAT IS
 * DELIBERATE. That statistic is near-peak by design — it is "the loudest thing
 * that is not a one-sample outlier" — and the Peaks stage exists to move
 * exactly those samples. Referenced to them, the makeup hands back what the
 * 1176 took (measured on synthetic narration: +7.0 dB of makeup at Peaks 3 /
 * Body 4, where the body had lost 4) and the memoryless ceiling ends up doing
 * the peak control, as a soft clipper. Level-matched instead, the voice comes
 * out as loud as it went in, the peaks come out lower by what Peaks and Body
 * took, and the A/B compares dynamics rather than loudness. The headroom is the
 * product; Loudness Normalize or the mastering chain spends it.
 *
 * ⚠ SEQUENTIAL, AND EACH STAGE IS MEASURED ON WHAT IT HEARS. Peaks on the
 * input; Body on the Peaks output (rendered once at the solved offset and then
 * fed to a kernel with Peaks bypassed, which at the base rate is a zero-length
 * delay, so it is the chain exactly); makeup on the whole chain.
 *
 * ⚠ ALL RENDERS ARE BASE RATE (`oversample: false`), as every compressor's
 * makeup solve is: the detector and the ballistics run at the base rate in
 * both modes, so the gain trajectory is the same; only the inter-sample detail
 * of the audio differs, which a block peak or a percentile barely sees.
 */
import { processVoxPressorBuffer, VoxPressorKernel } from './voxPressorProcessor.js'
import { VoiceDetector } from './dsp/voiceDetector.js'
import { measureVoiceProfile } from './voiceProfile.js'
import { gatedRmsOfChannels } from './dsp/inputAlign.js'
import {
  peakOfChannels, ceilingKneeDbFor, CEILING_KNEE_DB,
} from './dsp/makeupReference.js'

/** Block length for the peak and voiced-level statistics, seconds. */
export const SOLVE_BLOCK_S = 0.1
/** Share of blocks, by input peak, that count as "the loudest peaks". */
export const LOUDEST_SHARE = 0.1
const LOUDEST_MIN = 5
const LOUDEST_MAX = 60
/** Voiced = block RMS within this many dB of the gated level. Reasoned. */
export const VOICED_GATE_DB = 10
/**
 * How much the Peaks stage may lower the voice itself (median level drop on
 * the voiced blocks, dB) before the panel warns. A WARNING, NOT A CAP.
 *
 * ⚠ IT REPLACED A FIXED FLOOR THAT CAPPED THE KNOB. The first build kept the
 * 1176's knee ≥ 8 dB over the detector's gated level, a reasoned proxy for
 * "stay off the voice". On a real narration clip (−1 dBFS peak, −20.9 dBFS
 * gated) it stopped Peaks at 2.57 dB for every setting from 3 to 10 — while
 * the voice it was protecting measured 0.01 dB touched. Measured past it, the
 * same clip took 5.0 dB off its peaks for 0.24 dB of voice, 5.9 for 0.55, 6.7
 * for 0.97. The proxy was wrong by several dB, and a knob that silently stops
 * responding is worse than one that says what it is costing. Owner's call:
 * warn, don't cap. 0.5 is reasoned.
 */
export const PEAKS_BODY_WARN_DB = 0.5
/** Solve tolerance, dB, and the iteration cap. */
const TOL_DB = 0.05
const MAX_ITER = 12
const ALIGN_RANGE_DB = 60

export const PEAKS_MAX_DB = 10
export const BODY_MAX_DB = 10

function db(v) {
  return v > 0 ? 20 * Math.log10(v) : -Infinity
}

function blockStats(channels, sampleRate) {
  const n = channels[0].length
  const W = Math.max(1, Math.round(SOLVE_BLOCK_S * sampleRate))
  const nb = Math.floor(n / W)
  const peak = new Float64Array(nb)
  const rms = new Float64Array(nb)
  for (let b = 0; b < nb; b++) {
    let p = 0
    let e = 0
    for (const ch of channels) {
      for (let i = b * W; i < (b + 1) * W; i++) {
        const v = ch[i]
        const a = v < 0 ? -v : v
        if (a > p) p = a
        e += v * v
      }
    }
    peak[b] = p
    rms[b] = Math.sqrt(e / (W * channels.length))
  }
  return { peak, rms, W }
}

function median(values) {
  if (values.length === 0) return 0
  const s = Float64Array.from(values).sort()
  const m = s.length >> 1
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

/**
 * What a render did to the loudest peaks and to the body, against its input.
 * Both arrays must be latency-free against each other (base-rate renders are).
 */
export function peaksAndBodyDb(input, output, sampleRate, loudestIdx, voicedIdx) {
  const a = blockStats(input, sampleRate)
  const b = blockStats(output, sampleRate)
  const peaksDb = median(loudestIdx.map(k => db(a.peak[k]) - db(b.peak[k])))
  const bodyDb = median(voicedIdx.map(k => db(a.rms[k]) - db(b.rms[k])))
  return { peaksDb, bodyDb }
}

/** The loudest blocks by peak, and the voiced blocks by level, of the input. */
export function referenceBlocks(channels, sampleRate) {
  const { peak, rms } = blockStats(channels, sampleRate)
  const nb = peak.length
  const order = Array.from({ length: nb }, (_, k) => k).sort((x, y) => peak[y] - peak[x])
  const count = Math.max(LOUDEST_MIN, Math.min(LOUDEST_MAX, Math.round(nb * LOUDEST_SHARE)))
  const loudestIdx = order.slice(0, Math.min(nb, count)).filter(k => peak[k] > 0)
  const gatedDb = db(gatedRmsOfChannels(channels, sampleRate))
  const voicedIdx = []
  for (let k = 0; k < nb; k++) if (db(rms[k]) > gatedDb - VOICED_GATE_DB) voicedIdx.push(k)
  return { loudestIdx, voicedIdx, gatedDb }
}

/**
 * Root-find f(x) = target for a monotone-increasing f, from a guess.
 *
 * Secant steps from the guess, safeguarded by a bracket that tightens as the
 * signs of f − target come in; any step that leaves the bracket bisects it
 * instead. Starting near the answer is the whole saving: each evaluation is a
 * render of the region, and a bracket opened at the ±60 dB extremes spends
 * most of its renders discovering what a decent guess already knows.
 *
 * @param {number} slope  expected df/dx near the answer, for the first step
 * @returns {{ x: number, value: number, reached: boolean }}
 */
function solveFromGuess(f, target, guess, lo, hi, slope) {
  const clampX = x => (x < lo ? lo : x > hi ? hi : x)
  let a = lo
  let b = hi
  let x0 = clampX(guess)
  let f0 = f(x0)
  if (Math.abs(f0 - target) <= TOL_DB) return { x: x0, value: f0, reached: true }
  if (f0 < target) a = x0
  else b = x0
  let x1 = clampX(x0 + (target - f0) / slope)
  if (x1 === x0) {
    // Already pinned at a bound in the direction the answer lies.
    return { x: x0, value: f0, reached: false }
  }
  let f1 = f(x1)
  for (let i = 0; i < MAX_ITER; i++) {
    if (Math.abs(f1 - target) <= TOL_DB) return { x: x1, value: f1, reached: true }
    if (f1 < target) a = Math.max(a, x1)
    else b = Math.min(b, x1)
    // At a bound and still short of the target in its direction: done.
    if ((x1 === hi && f1 < target) || (x1 === lo && f1 > target)) {
      return { x: x1, value: f1, reached: false }
    }
    let x2 = f1 !== f0 ? x1 - (f1 - target) * (x1 - x0) / (f1 - f0) : NaN
    if (!Number.isFinite(x2) || x2 <= a || x2 >= b) {
      // Out of the bracket (or no slope): bisect what is known, or step out
      // by the expected slope when one side is still open.
      x2 = a > lo && b < hi ? 0.5 * (a + b) : clampX(x1 + (target - f1) / slope)
      if (x2 === x1) return { x: x1, value: f1, reached: false }
    }
    x0 = x1
    f0 = f1
    x1 = x2
    f1 = f(x1)
  }
  return { x: x1, value: f1, reached: Math.abs(f1 - target) <= 2 * TOL_DB }
}

/**
 * Solve VoxPressor for one region.
 *
 * @param {Float32Array[]} channels   the region (or its analysis window)
 * @param {number} sampleRate
 * @param {object} p
 * @param {number} p.peaksDb          Peaks knob, dB off the loudest peaks (0 = off)
 * @param {number} p.bodyDb           Body knob, dB of average leveling (0 = off)
 * @param {object} [p.peaksBench]     bench overrides, forwarded to the kernel
 * @param {object} [p.bodyBench]
 * @param {number|null} [p.cornerHz] the voice's rumble corner, if already
 *   measured (null = unmeasurable; absent = measure it here)
 * @param {number} [p.bodyGuess]      a starting point for the Body solve —
 *   the last solve's `bodyAlignDb`
 * @param {boolean} [p.wholeRegion]   whether `channels` is the whole region —
 *   the ceiling's knee is sized from the render only then (see `ceilingKneeDbFor`)
 */
export function solveVoxPressor(channels, sampleRate, p = {}) {
  const peaksTarget = Math.max(0, Math.min(PEAKS_MAX_DB, Number(p.peaksDb) || 0))
  const bodyTarget = Math.max(0, Math.min(BODY_MAX_DB, Number(p.bodyDb) || 0))
  const bench = { peaksBench: p.peaksBench ?? null, bodyBench: p.bodyBench ?? null }

  // The corner is a property of the file, not of the knobs: callers that solve
  // repeatedly measure it once and pass it in (it is ~40 % of a solve's cost).
  const cornerHz = p.cornerHz === undefined
    ? (measureVoiceProfile(channels, sampleRate)?.cornerHz ?? null)
    : p.cornerHz
  const base = { ...bench, oversample: false, makeupDb: 0, ceilingDb: null, outputDb: 0 }
  if (cornerHz) base.cornerHz = cornerHz

  const inPeak = peakOfChannels(channels)
  if (!(inPeak > 0)) {
    return {
      cornerHz, peaksOn: false, bodyOn: false, peaksAlignDb: 0, bodyAlignDb: 0,
      makeupDb: 0, ceilingDb: null, ceilingKneeDb: null,
      peaksDb: 0, peaksBodyDb: 0, peaksLimited: false, bodyDb: 0,
    }
  }
  const ref = referenceBlocks(channels, sampleRate)

  // ── PEAKS ──
  let peaksAlignDb = 0
  let peaksDb = 0
  let peaksBodyDb = 0
  let peaksLimited = false
  let afterPeaks = channels
  const peaksOn = peaksTarget > 0
  if (peaksOn) {
    // The kernel's own terms, for the first guess below:
    // over = detLevel + inputDriveDb + align − threshold.
    const probe = new VoxPressorKernel(sampleRate)
    probe.setParams(base)
    const fet = probe.fet
    const det = new VoiceDetector(sampleRate, { plosive: false })
    det.setCornerHz(cornerHz)
    const detSig = det.process(channels, channels[0].length).slice()
    const hi = ALIGN_RANGE_DB
    const lo = -ALIGN_RANGE_DB

    let last = null
    const measure = (align) => {
      const out = processVoxPressorBuffer(channels, sampleRate, {
        ...base, peaksOn: true, bodyOn: false, peaksAlignDb: align,
      }).channelData
      last = { align, out, ...peaksAndBodyDb(channels, out, sampleRate, ref.loudestIdx, ref.voicedIdx) }
      return last.peaksDb
    }
    // First guess from the static curve: put the loudest peaks' detector level
    // `target / slope` dB over the threshold. The knee and the ballistics make
    // the real reduction a little less; the secant takes it from there.
    const W = Math.round(SOLVE_BLOCK_S * sampleRate)
    const detPeaks = ref.loudestIdx.map((k) => {
      let m = 0
      for (let i = k * W; i < (k + 1) * W; i++) {
        const a = detSig[i] < 0 ? -detSig[i] : detSig[i]
        if (a > m) m = a
      }
      return db(m)
    })
    const slope = fet.slope > 0 ? fet.slope : 0.9
    const guess = fet.thresholdDb - median(detPeaks) - fet.inputDriveDb + peaksTarget / slope
    const r = solveFromGuess(measure, peaksTarget, guess, lo, hi, slope)
    // `last` is the render at r.x unless the bracket ends returned early.
    if (!last || last.align !== r.x) measure(r.x)
    peaksAlignDb = r.x
    peaksDb = last.peaksDb
    peaksBodyDb = last.bodyDb
    // Only when the whole offset range cannot reach the target — material too
    // quiet or too short to measure, not a guard.
    peaksLimited = !r.reached && r.x >= hi - 1e-9
    afterPeaks = last.out
  }

  // ── BODY ── measured on what Peaks left.
  let bodyAlignDb = 0
  let bodyDb = 0
  let final = afterPeaks
  const bodyOn = bodyTarget > 0
  if (bodyOn) {
    const midRef = referenceBlocks(afterPeaks, sampleRate)
    const W = Math.round(SOLVE_BLOCK_S * sampleRate)
    let last = null
    const measure = (align) => {
      const r = processVoxPressorBuffer(afterPeaks, sampleRate, {
        ...base, peaksOn: false, bodyOn: true, bodyAlignDb: align,
      }, { meter: true })
      // Average cell reduction over the voiced blocks, from the cell's own
      // meter (one value per 128-sample kernel block).
      const per = W / 128
      let s = 0
      let c = 0
      for (const k of midRef.voicedIdx) {
        const from = Math.floor(k * per)
        const to = Math.min(r.bodyGr.length, Math.floor((k + 1) * per))
        for (let j = from; j < to; j++) { s += r.bodyGr[j]; c++ }
      }
      last = { align, out: r.channelData, value: c > 0 ? s / c : 0 }
      return last.value
    }
    // No closed-form guess for an opto cell's AVERAGE reduction; a caller
    // re-solving after a knob move passes the last answer (`p.bodyGuess`).
    const guess = Number.isFinite(p.bodyGuess) ? p.bodyGuess : 0
    const r = solveFromGuess(measure, bodyTarget, guess, -ALIGN_RANGE_DB, ALIGN_RANGE_DB, 0.6)
    if (!last || last.align !== r.x) measure(r.x)
    bodyAlignDb = r.x
    bodyDb = last.value
    final = last.out
  }

  // ── MAKEUP + CEILING ── closed form: the makeup is the last multiply.
  const refIn = gatedRmsOfChannels(channels, sampleRate)
  const refOut = gatedRmsOfChannels(final, sampleRate)
  const makeupDb = refIn > 0 && refOut > 0
    ? Math.max(-24, Math.min(24, db(refIn) - db(refOut))) : 0
  const ceilingDb = db(inPeak)
  const overshootDb = db(peakOfChannels(final)) + makeupDb - ceilingDb
  const ceilingKneeDb = p.wholeRegion ? ceilingKneeDbFor(overshootDb) : CEILING_KNEE_DB

  return {
    cornerHz,
    peaksOn, bodyOn,
    peaksAlignDb, bodyAlignDb,
    makeupDb, ceilingDb, ceilingKneeDb,
    peaksDb, peaksBodyDb, peaksLimited,
    bodyDb,
  }
}
