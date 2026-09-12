/**
 * Loudness normalization — turning a measurement and a target into a rendered
 * region, and holding a peak ceiling while doing it.
 *
 * Dependency-free apart from its two siblings under dsp/, because it runs in
 * the measurement worker.
 *
 * ── WHY THIS IS NOT ONE MULTIPLICATION ──────────────────────────────────────
 * Peak normalizing is: measure the peak, divide, done — one gain, and the peak
 * lands exactly where it was asked to. Loudness normalizing is not, because the
 * two things a delivery spec states are in tension. "-16 LUFS with peaks no
 * higher than -1 dBTP" is two constraints on one gain, and on speech they
 * routinely disagree: narration with a 14 dB crest factor cannot sit at -16
 * LUFS and keep its peaks under -1 dBTP, because the gain that satisfies one
 * overshoots the other.
 *
 * So the caller chooses which constraint gives — see PEAK_MODES — and where the
 * answer is "hold the ceiling and hit the target anyway", the peaks have to
 * come down by something other than gain. That is the limiter below, and it is
 * why this is a solve rather than an arithmetic step: limiting peaks LOWERS the
 * loudness it was applied to, so the gain that hit the target before limiting
 * undershoots it after. The loop re-measures and closes the gap.
 *
 * ── EVERY NUMBER THE PANEL PRINTS COMES BACK FROM HERE ──────────────────────
 * `achievedDb` is measured on the rendered output, not predicted from the
 * gain. A predicted figure and a rendered file that disagree is the failure
 * this whole module exists to avoid — the user is aiming at a spec somebody
 * else will check.
 */

import { measureLoudness, measureIntegratedLufs, measureRmsDb, measureSamplePeakDb, measureTruePeakDb } from './loudness.js'
import { LookaheadLimiter } from './lookaheadLimiter.js'

/**
 * What gives when the target and the ceiling cannot both be met.
 *
 * ⚠ NEITHER IS A DEFAULT FOR THE OTHER'S JOB, which is why this is a switch on
 * the faceplate rather than a preference buried somewhere. LIMIT delivers the
 * number the platform asked for and pays for it in peak reduction; SAFE
 * delivers the file untouched apart from one gain and reports how far short of
 * the target that landed. A narrator submitting to ACX wants SAFE far more
 * often than a podcaster hitting -16 LUFS does.
 */
export const PEAK_MODES = [
  {
    id: 'limit',
    label: 'LIMIT',
    caption: 'hits the target, limits peaks to the ceiling',
  },
  {
    id: 'safe',
    label: 'SAFE',
    caption: 'one gain only, stops at the ceiling',
  },
]

/** Lookahead half-width, in ms. Latency is twice this and is removed. */
const LOOKAHEAD_MS = 2

/**
 * How close to the target counts as arrived, in dB.
 *
 * Tighter than any delivery spec cares about — platforms tolerate a LU either
 * way — and set from the READOUT rather than from the spec: the panel prints
 * one decimal, so anything looser lets a converged render show "-16.1" under a
 * knob reading "-16.0". A user checking a compliance number against a panel
 * that disagrees with itself has no reason to trust either.
 */
const TARGET_TOLERANCE_DB = 0.04
/** How far over the ceiling counts as over, in dB. */
const CEILING_TOLERANCE_DB = 0.01
/**
 * Iterations of the gain/limit solve.
 *
 * Pass one gains and limits, pass two corrects the loudness the limiting cost
 * and any true-peak overshoot the sample-domain limiter left, and the rest are
 * margin — on real narration at every shipping target it settles in one or
 * two. The loop also stops early when a pass stops helping (see
 * STALL_TOLERANCE_DB), so the cap is reached only by material that genuinely
 * cannot get there.
 */
const MAX_PASSES = 4

/**
 * A pass that improves the shortfall by less than this has stopped working.
 *
 * ⚠ THERE IS A LOUDNESS A LOOKAHEAD LIMITER CANNOT REACH, and it is well below
 * "as loud as you like". Past a certain ask the envelope ducks the body of the
 * signal by as much as the extra gain added, so each pass buys almost nothing
 * — measured on a spiky region asked for -10 LUFS, six passes moved it 0.5 LU
 * and it never arrived. Detecting that and stopping is what turns a wasted
 * render into `converged: false` and an honest reading on the panel; every
 * shipping target here is inside what the limiter can do, so this fires only
 * on a hand-typed one.
 */
const STALL_TOLERANCE_DB = 0.05

const dbToLin = db => Math.pow(10, db / 20)

/**
 * Apply one gain to every channel. Not clamped: clamping here would be a
 * hard-clip nobody asked for, and the ceiling is the caller's business.
 */
export function applyGain(channelData, gainDb) {
  const g = dbToLin(gainDb)
  return channelData.map(ch => {
    const out = new Float32Array(ch.length)
    for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g
    return out
  })
}

/**
 * Hold every channel's peaks at or below `ceilingDb`, with a channel-linked
 * lookahead limiter.
 *
 * ⚠ THE GAIN IS COMPUTED FROM THE LOUDEST CHANNEL AND APPLIED TO ALL OF THEM.
 * Limiting each channel independently is the same thing as moving the image:
 * on a two-host podcast a loud plosive from one host would pull that side down
 * on its own and swing the stereo picture, which is audible and wrong. One
 * detector, one envelope, applied to everything.
 *
 * The envelope comes from `LookaheadLimiter`, whose no-overshoot guarantee is
 * structural — see its own file. The audio is fed with a tail of silence so
 * that the last real sample makes it out of the delay line, and the leading
 * `latencySamples` are dropped, so the returned region is sample-aligned with
 * what went in.
 */
export function limitToCeiling(channelData, ceilingDb, sampleRate) {
  const n = channelData[0]?.length ?? 0
  if (!n) return channelData

  const threshold = dbToLin(ceilingDb)
  const half = Math.max(1, Math.round((LOOKAHEAD_MS / 1000) * sampleRate))
  const limiter = new LookaheadLimiter(half)
  const latency = limiter.latencySamples

  const out = channelData.map(() => new Float32Array(n))
  const delays = channelData.map(() => new Float32Array(latency))
  let pos = 0

  for (let i = 0; i < n + latency; i++) {
    // The detector sees the loudest channel at this instant.
    let side = 0
    if (i < n) {
      for (const ch of channelData) {
        const a = ch[i] < 0 ? -ch[i] : ch[i]
        if (a > side) side = a
      }
    }
    limiter.processSample(side, threshold)
    const g = limiter.gain

    // Our own delay lines, read-before-write, so each channel comes out of the
    // same instant the envelope was computed for.
    const o = i - latency
    for (let c = 0; c < channelData.length; c++) {
      const held = delays[c][pos]
      delays[c][pos] = i < n ? channelData[c][i] : 0
      if (o >= 0) out[c][o] = held * g
    }
    pos = pos + 1 === latency ? 0 : pos + 1
  }

  return out
}

/**
 * The loudness a target is stated in, read off a measurement.
 *
 * One place, because the alternative is every caller writing the same ternary
 * and one of them getting it backwards — which would show a narrator an LUFS
 * figure next to an ACX target and a gain computed from neither.
 */
export function measuredFor(measurement, unit) {
  return unit === 'RMS' ? measurement.rmsDb : measurement.lufs
}

/**
 * The peak reading a target's ceiling is stated against.
 *
 * ACX audits sample peak — its requirement is "-3 dB peak" on the submitted
 * file, and it does not oversample to find inter-sample peaks. Streaming and
 * broadcast specs are stated in dBTP and mean it, because their encoders
 * resample. Aiming at the wrong one of these is a real failure in both
 * directions: dBTP against ACX leaves ~0.5 dB of level on the table, sample
 * peak against Spotify ships a file that clips their transcode.
 */
export function peakFor(measurement, unit) {
  return unit === 'RMS' ? measurement.samplePeakDb : measurement.truePeakDb
}

/**
 * What normalizing this region to this target would do, without rendering it.
 *
 * Feeds the panel's readout so the user sees the gain, and whether the ceiling
 * is going to get in the way, before committing to a render.
 *
 * @returns {{measuredDb:number, gainDb:number, requestedGainDb:number,
 *   peakBeforeDb:number, peakAfterDb:number, ceilingHit:boolean,
 *   shortfallDb:number, silent:boolean}}
 */
export function planNormalization(measurement, target, peakMode) {
  const measuredDb = measuredFor(measurement, target.unit)
  const peakBeforeDb = peakFor(measurement, target.unit)

  if (!Number.isFinite(measuredDb) || !Number.isFinite(peakBeforeDb)) {
    return {
      measuredDb, gainDb: 0, requestedGainDb: 0,
      peakBeforeDb, peakAfterDb: peakBeforeDb,
      ceilingHit: false, shortfallDb: 0, silent: true,
    }
  }

  const requestedGainDb = target.targetDb - measuredDb
  const headroomGainDb = target.ceilingDb - peakBeforeDb
  const ceilingHit = requestedGainDb > headroomGainDb
  const gainDb = peakMode === 'safe' && ceilingHit ? headroomGainDb : requestedGainDb

  return {
    measuredDb,
    gainDb,
    requestedGainDb,
    peakBeforeDb,
    peakAfterDb: peakBeforeDb + gainDb,
    ceilingHit,
    // Only SAFE can fall short by construction. LIMIT's shortfall, if any, is
    // whatever the render actually achieved and is measured, not predicted.
    shortfallDb: peakMode === 'safe' && ceilingHit ? requestedGainDb - gainDb : 0,
    silent: false,
  }
}

/**
 * Read a rendered region back on the meters the target is stated in.
 *
 * One helper rather than the same pair of ternaries at each return, because the
 * two paths through the render must not be able to answer with different
 * measurements of the same output.
 */
function measureAgainst(channelData, sampleRate, target) {
  return {
    achievedDb: target.unit === 'RMS'
      ? measureRmsDb(channelData)
      : measureIntegratedLufs(channelData, sampleRate),
    achievedPeakDb: target.unit === 'RMS'
      ? measureSamplePeakDb(channelData)
      : measureTruePeakDb(channelData),
  }
}

/**
 * Normalize a region to a target and return the rendered channels plus a
 * report measured on them.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {{targetDb:number, unit:'LUFS'|'RMS', ceilingDb:number}} target
 * @param {'limit'|'safe'} peakMode
 */
export function renderLoudnessNormalize(channelData, sampleRate, target, peakMode) {
  const before = measureLoudness(channelData, sampleRate)
  const plan = planNormalization(before, target, peakMode)

  if (plan.silent) {
    return {
      channelData,
      report: {
        ...plan, achievedDb: plan.measuredDb, achievedPeakDb: plan.peakBeforeDb,
        limitedDb: 0, passes: 0, converged: true,
      },
    }
  }

  // SAFE, or a target that fits under the ceiling on its own: one gain, no
  // limiter, nothing to converge.
  if (peakMode === 'safe' || !plan.ceilingHit) {
    const out = applyGain(channelData, plan.gainDb)
    // ⚠ THE RESULT IS MEASURED, NOT `measuredDb + gainDb`, AND THE SHORTCUT IS
    // WRONG EVEN THOUGH THE GAIN IS EXACT. RMS really does move by the gain, so
    // the two agree there — but LUFS is GATED, and both gates are evaluated
    // against a fixed absolute threshold. Lifting a region by 8 dB can carry
    // blocks of room tone up across -70 LKFS that were under it before, and
    // once they are in the average the answer is no longer `before + gain`.
    // A recording quiet enough to need a large boost is exactly the one whose
    // floor sits near the gate, so the case this gets wrong is not a corner —
    // it is the file the user reached for this tool to fix. Predicting it here
    // would also make this the one path whose printed figure was not the
    // rendered one, which is the promise the whole module is built on.
    const { achievedDb, achievedPeakDb } = measureAgainst(out, sampleRate, target)
    return {
      channelData: out,
      report: {
        ...plan,
        achievedDb,
        achievedPeakDb,
        limitedDb: 0,
        passes: 1,
        converged: true,
      },
    }
  }

  // LIMIT: gain to the target, pull the peaks back to the ceiling, then close
  // the loudness the limiting cost.
  let extraDb = 0
  let guardDb = 0
  let out = null
  let achievedDb = plan.measuredDb
  let achievedPeakDb = plan.peakAfterDb
  let passes = 0
  let converged = false
  let lastShort = Infinity

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    passes = pass
    out = limitToCeiling(
      applyGain(channelData, plan.gainDb + extraDb),
      target.ceilingDb - guardDb,
      sampleRate,
    )

    ;({ achievedDb, achievedPeakDb } = measureAgainst(out, sampleRate, target))

    const over = achievedPeakDb - target.ceilingDb
    const short = target.targetDb - achievedDb
    if (over <= CEILING_TOLERANCE_DB && Math.abs(short) <= TARGET_TOLERANCE_DB) {
      converged = true
      break
    }
    // ⚠ THE CEILING IS CORRECTED FIRST AND UNCONDITIONALLY. The limiter holds
    // SAMPLE peaks by construction; a true-peak ceiling can still be exceeded
    // between them, and the only way to take that back is to limit lower. A
    // pass that only chased the target would keep handing back an over-ceiling
    // file that reads as a success.
    if (over > CEILING_TOLERANCE_DB) guardDb += over
    if (short > TARGET_TOLERANCE_DB) extraDb += short
    if (lastShort - short < STALL_TOLERANCE_DB) break
    lastShort = short
  }

  return {
    channelData: out,
    report: {
      ...plan,
      achievedDb,
      achievedPeakDb,
      limitedDb: plan.gainDb + extraDb + plan.peakBeforeDb - achievedPeakDb,
      passes,
      converged,
    },
  }
}
