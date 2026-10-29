/**
 * VoxPressor's per-file measurements: the readouts under the knobs and each
 * stage's makeup. See docs/voxpressor_spec.md §4.2 and §5.
 *
 * The knobs are the compressors' own — Peaks is the 1176's Input, Body the
 * LA-2A's Peak Reduction — each offset by the file's gated-RMS alignment, so a
 * position means the same at any recording level and the compression answers
 * a knob move at once. Nothing here moves a knob. What it measures, from one
 * render per stage:
 *
 * - PEAKS (readout) — how far the 1176 took the loudest peaks down: the
 *   median, over the loudest blocks, of each block's input peak minus its
 *   output peak; and what it cost the voice (`peaksBodyDb`, the median level
 *   drop on the voiced blocks), which the panel warns about past
 *   `PEAKS_BODY_WARN_DB`.
 * - BODY (readout) — the LA-2A's average gain reduction over the voiced blocks
 *   of what the Peaks stage left.
 * - MAKEUP — PER STAGE, as the owner's hand-built 1176 → LA-2A chain does
 *   it: each stage makes up its own level with the compressors' shared
 *   99.9th-percentile reference, runs into a lookahead LIMITER at the
 *   source's peak, and has its peak restored to that ceiling. Always on, no
 *   switch (owner's call). The 1176's in closed form (`percentileMakeupDb`),
 *   the LA-2A's by `solveMakeupPlan`.
 *
 * ⚠ A LIMITER, NOT THE COMPRESSORS' SOFT CEILING. The percentile makeup lifts
 * a few onsets 3–4 dB over the ceiling (0.15 % of "Messy and Bright"'s samples
 * at Body 4). The plugins' own `softCeiling` bends them with a tanh, which
 * distorts on loud transients (owner's verdict: the harmonics this chain is
 * tuned for are the LA-2A's, not the ceiling's). The limiter takes them down
 * with a gain.
 *
 * ⚠ ONE KERNEL RENDER PER STAGE, AND THE LIMITERS OFFLINE (`limitChannels`).
 * The first build re-rendered the kernel for every makeup step and every
 * restore: 3.2 s on 30 s of narration against LA Vintage 2A's 0.75 s, felt as
 * the makeup and readouts lagging both standalone plugins.
 *
 * ⚠ THE KNOBS WERE TARGETS FIRST, SOLVED BY A SECANT SEARCH over each stage's
 * detector offset ("Peaks 3" = 3 dB off the peaks on every voice). Replaced
 * by direct knobs (owner's call): beyond the gated-RMS alignment the search
 * moved the offset only 1.1–1.2 dB (Peaks) and 0.3–0.4 dB (Body) between two
 * real clips 3.3 dB apart in crest, while it cost a 4–7 s wait on every knob
 * move during which the old setting kept playing.
 *
 * ⚠ WHY PER STAGE. One peak restore after both compressors (the previous
 * build) could not match the chain: the LA-2A's slow opto lowers the sustained
 * voice more than each syllable's onset, so the crest grows and a single
 * restore hands back only what the peak-to-body gap shrank — +1.0 dB at Peaks
 * 3 / Body 4 on the owner's "Messy and Bright" clip, where the chain made
 * +3.3. Per stage it is +3.5, almost all from the 1176 stage, as the owner
 * described the chain. The extra level is each stage's limiter taking down
 * the few onsets the percentile-referenced makeup lifts over the source peak.
 *
 * ⚠ HISTORY. Level-matched makeup (gated RMS back on the input's) was stage
 * 1's and was rejected for never making anything louder. A single true-peak
 * restore came next and lost to the per-stage chain above; it was also pinned
 * by any one peak the 1176 could not see — a bright "s" on "Messy and Bright"
 * left the whole clip 3.6 dB quieter until the 1176's detector was made to
 * hear sibilance (`peaksTap`).

 * ⚠ SEQUENTIAL, AND EACH STAGE IS MEASURED ON WHAT IT HEARS. Peaks on the
 * input; Body on the Peaks output (rendered once with its makeup and then fed
 * to a kernel with Peaks bypassed, which at the base rate is a zero-length
 * delay, so it is the chain exactly); each stage's makeup on its own output.
 *
 * ⚠ ALL RENDERS ARE BASE RATE (`oversample: false`), as every compressor's
 * makeup solve is: the detector and the ballistics run at the base rate in
 * both modes, so the gain trajectory is the same; only the inter-sample detail
 * of the audio differs, which a block peak or a percentile barely sees.
 */
import { processVoxPressorBuffer } from './voxPressorProcessor.js'
import { measureVoiceProfile } from './voiceProfile.js'
import { gatedRmsOfChannels } from './dsp/inputAlign.js'
import {
  peakOfChannels, solveMakeupPlan, percentileOfChannels, MAKEUP_PERCENTILE,
} from './dsp/makeupReference.js'
import { limitChannels } from './dsp/peakLimiter.js'

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
 * Measure VoxPressor for one region at the current knobs: the readouts and
 * every stage's makeup, ceiling and restore.
 *
 * @param {Float32Array[]} channels   the region (or its analysis window)
 * @param {number} sampleRate
 * @param {object} p                  KERNEL params (`toKernelParams`): the
 *   knobs, `peaksOn` / `bodyOn`, both alignments and the bench
 * @param {number|null} [p.cornerHz]  the voice's rumble corner, if already
 *   measured (null = unmeasurable; absent = measure it here)
 */
export function measureVoxPressor(channels, sampleRate, p = {}) {
  // The corner is a property of the file, not of the knobs: callers that
  // measure repeatedly measure it once and pass it in.
  const cornerHz = p.cornerHz === undefined
    ? (measureVoiceProfile(channels, sampleRate)?.cornerHz ?? null)
    : p.cornerHz
  const base = {
    ...p, oversample: false, listen: 'off', outputDb: 0, makeupDb: 0,
    peaksMakeupDb: 0, peaksCeilingDb: null, bodyMakeupDb: 0, bodyCeilingDb: null,
  }
  if (cornerHz) base.cornerHz = cornerHz
  else delete base.cornerHz

  const none = {
    cornerHz,
    peaksMakeupDb: 0, peaksCeilingDb: null, peaksRestoreDb: 0,
    bodyMakeupDb: 0, bodyCeilingDb: null, makeupDb: 0,
    peaksDb: 0, peaksBodyDb: 0, bodyDb: 0,
  }
  const inPeak = peakOfChannels(channels)
  if (!(inPeak > 0)) return none
  // Both stages' limiters hold the SOURCE's peak.
  const ceilingDb = db(inPeak)
  const out = { ...none }

  // ── PEAKS ──
  let afterPeaks = channels
  if (p.peaksOn) {
    const ref = referenceBlocks(channels, sampleRate)
    // ONE render of the 1176 stage, at unity: the readouts, the makeup and the
    // stage's output all come from it (see `peaksStage`).
    const raw = renderPeaks(channels, sampleRate, base, {})
    const r = peaksAndBodyDb(channels, raw, sampleRate, ref.loudestIdx, ref.voicedIdx)
    out.peaksDb = r.peaksDb
    out.peaksBodyDb = r.bodyDb
    const gainDb = percentileMakeupDb(channels, raw)
    const st = peaksStage(raw, gainDb, ceilingDb, sampleRate)
    out.peaksRestoreDb = st.restoreDb
    out.peaksMakeupDb = gainDb + st.restoreDb
    out.peaksCeilingDb = ceilingDb
    afterPeaks = st.out
  }

  // ── BODY ── on what the 1176 stage put out, makeup and all.
  if (p.bodyOn) {
    // In the chain the kernel takes the Body offset net of the Peaks makeup;
    // rendered alone (Peaks bypassed) it has to be passed that way.
    const bodyAlignDb = bodyAlignFor(p, out.peaksMakeupDb)
    const midRef = referenceBlocks(afterPeaks, sampleRate)
    const W = Math.round(SOLVE_BLOCK_S * sampleRate)
    /**
     * The LA-2A stage's own makeup (its Gain, before the valve — so the plan
     * iterates renders), limiter at the source peak, and peak restore, which
     * lands as the gain between the LA-2A and its limiter (`makeupDb`).
     *
     * ⚠ THREE RENDERS BECAME ONE OR TWO, and each saving rests on a fact about
     * this kernel, measured: (1) its gain reduction does not depend on its
     * makeup (0.000000 dB apart at 0 and +6), so the readout's meter comes
     * from whichever render the plan makes first; (2) the plan starts from
     * the caller's last answer (`p.bodyMakeupGuess`), so a knob move usually
     * converges in one render; (3) the CONVERGED RENDER IS KEPT AS THE STAGE —
     * its makeup is the rendered value, within the plan's 0.05 dB tolerance of
     * the next step — and the limiter and the restore run offline on it, as
     * the 1176 stage's do, instead of a final kernel render.
     */
    let first = null
    let last = null
    solveMakeupPlan({
      channelData: afterPeaks,
      render: (chs, extra) => {
        const rr = renderBody(chs, sampleRate, base, bodyAlignDb, extra, { meter: first === null })
        if (first === null) first = rr
        return rr.channelData
      },
      onRender: (o, makeupDb) => { last = { out: o, makeupDb } },
      initialDb: p.bodyMakeupGuess,
      gainKey: 'bodyMakeupDb',
      reference: 'percentile',
      minDb: -24,
      maxDb: 24,
    })
    out.bodyMakeupDb = last ? last.makeupDb : 0
    out.bodyCeilingDb = ceilingDb
    out.makeupDb = last ? restoreToCeilingDb(ceilingDb, db(peakOfChannels(limitChannels(last.out, ceilingDb, sampleRate)))) : 0
    const r = first
    // Average cell reduction over the voiced blocks, from the cell's own meter
    // (one value per 128-sample kernel block).
    const per = W / 128
    let sum = 0
    let count = 0
    for (const k of midRef.voicedIdx) {
      const from = Math.floor(k * per)
      const to = Math.min(r.bodyGr.length, Math.floor((k + 1) * per))
      for (let j = from; j < to; j++) { sum += r.bodyGr[j]; count++ }
    }
    out.bodyDb = r && count > 0 ? sum / count : 0
  }
  return out
}

/**
 * The 1176 stage's percentile makeup, in CLOSED FORM: its Output is the last
 * multiply on its path at Mix 1, so the stage's output is `raw · g` exactly and
 * the 99.9th percentile scales with it — one render answers it, as LA Classic
 * 76's own plan does (`computeFET1176AutoMakeupPlan`). Iterating renders here
 * cost four or five of them for the same number.
 */
function percentileMakeupDb(input, raw) {
  const a = percentileOfChannels(input, MAKEUP_PERCENTILE)
  const b = percentileOfChannels(raw, MAKEUP_PERCENTILE)
  if (!(a > 0) || !(b > 0)) return 0
  return Math.max(-24, Math.min(24, db(a) - db(b)))
}

/**
 * The 1176 stage at a makeup, from its unity render: `raw` scaled, into the
 * limiter at `ceilingDb`, with the peak restore that puts the stage's peak on
 * the ceiling — all offline on the samples, no kernel render. The kernel
 * applies the same gain on its Output and the same limiter
 * (`limitChannels` is that limiter, run whole), so this is the chain to
 * float rounding.
 *
 * @returns {{ restoreDb: number, out: Float32Array[] }}
 */
function peaksStage(raw, gainDb, ceilingDb, sampleRate) {
  const scale = (g) => raw.map((c) => {
    const k = 10 ** (g / 20)
    const q = new Float32Array(c.length)
    for (let i = 0; i < c.length; i++) q[i] = c[i] * k
    return q
  })
  let out = limitChannels(scale(gainDb), ceilingDb, sampleRate)
  const restoreDb = restoreToCeilingDb(ceilingDb, db(peakOfChannels(out)))
  // A restore only ever lifts a stage that landed under the ceiling, so it
  // gives the limiter nothing new; re-run so the samples are the kernel's.
  if (restoreDb !== 0) out = limitChannels(scale(gainDb + restoreDb), ceilingDb, sampleRate)
  return { restoreDb, out }
}

/** The Body stage's detector offset when rendered with the Peaks stage bypassed. */
function bodyAlignFor(p, peaksMakeupDb) {
  const a = Number.isFinite(p.bodyAlignDb) ? p.bodyAlignDb : 0
  return p.peaksOn ? a - peaksMakeupDb : a
}

/** The gain that puts a rendered peak back on its ceiling. */
export function restoreToCeilingDb(ceilingDb, peakDb) {
  if (!Number.isFinite(ceilingDb) || !Number.isFinite(peakDb)) return 0
  return Math.max(-24, Math.min(24, ceilingDb - peakDb))
}

/** Render the Peaks stage alone (base rate) — the measurement's and the exact pass's. */
function renderPeaks(channels, sampleRate, base, extra = {}) {
  return processVoxPressorBuffer(channels, sampleRate, {
    ...base, peaksOn: true, bodyOn: false, ...extra,
  }, { compensate: true }).channelData
}

/** Render the Body stage alone (base rate). */
function renderBody(channels, sampleRate, base, alignDb, extra = {}, opts = {}) {
  return processVoxPressorBuffer(channels, sampleRate, {
    ...base, peaksOn: false, bodyOn: true, bodyAlignDb: alignDb, ...extra,
  }, { ...opts, compensate: true })
}

/**
 * EXACT per-stage restores over a WHOLE region, for one longer than the
 * measurement's analysis window. Returns the params with the restores and the
 * ceilings corrected.
 *
 * ⚠ A WINDOW'S PEAK IS ONLY A LOWER BOUND ON THE REGION'S, so a restore
 * derived from it is too generous and pushes the passage it never saw into
 * the limiter (the LA Classic 76 peak-restore lesson in CLAUDE.md). The
 * makeups stay the window's, as every compressor's do; the two restores are
 * re-measured here. The Body stage follows the 1176 stage's new makeup by
 * itself (its offset is taken net of it).
 *
 * @param {object} solved        kernel params with the measurement applied
 * @param {number} sourcePeakDb  the whole region's peak, dBFS
 */
export function measureVoxPressorExact(channels, sampleRate, solved, sourcePeakDb) {
  const base = { ...solved, oversample: false, listen: 'off', outputDb: 0, makeupDb: 0 }
  let stage1 = channels
  let peaksMakeupDb = 0
  let peaksCeilingDb = null
  let peaksRestoreDb = 0
  if (solved.peaksOn) {
    const gainDb = solved.peaksMakeupDb - solved.peaksRestoreDb
    const raw = renderPeaks(channels, sampleRate, base, { peaksMakeupDb: 0, peaksCeilingDb: null })
    const st = peaksStage(raw, gainDb, sourcePeakDb, sampleRate)
    peaksRestoreDb = st.restoreDb
    peaksMakeupDb = gainDb + peaksRestoreDb
    peaksCeilingDb = sourcePeakDb
    stage1 = st.out
  }
  let bodyCeilingDb = null
  let makeupDb = 0
  if (solved.bodyOn) {
    bodyCeilingDb = sourcePeakDb
    // The same arithmetic as `measureVoxPressor`: the LA-2A at its makeup,
    // then the limiter offline.
    const out = renderBody(stage1, sampleRate, base, bodyAlignFor(solved, peaksMakeupDb), {
      bodyMakeupDb: solved.bodyMakeupDb, bodyCeilingDb: null,
    }).channelData
    makeupDb = restoreToCeilingDb(bodyCeilingDb, db(peakOfChannels(limitChannels(out, bodyCeilingDb, sampleRate))))
  }
  return {
    ...solved,
    peaksMakeupDb, peaksCeilingDb, peaksRestoreDb,
    bodyCeilingDb,
    makeupDb,
  }
}
