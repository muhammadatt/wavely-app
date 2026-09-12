/**
 * AUTO LEVEL — clip-based gain riding, client port of the server's Stage 4b.
 *
 * Direct port of `server/pipeline/autoLeveler.js`: same segmentation, same
 * per-clip gain law, same merge and crossfade rules, same constants. Read that
 * file for the design; this one documents only where the browser forced a
 * difference, and why each difference is sound.
 *
 * ⚠ IT IS NOT A GAIN-RIDING CURVE, AND THAT IS THE WHOLE DESIGN. There is no
 * continuous IIR smoothing of a sample-rate gain. Audio is segmented into voiced
 * clips, each clip gets ONE flat gain, and adjacent clips are crossfaded at the
 * lowest-energy point between them. So the dynamics INSIDE a clip are preserved
 * exactly — a leveller that rides continuously is a slow compressor wearing a
 * different name, and it flattens the syllable-scale movement the compressors
 * downstream are supposed to act on.
 *
 * ⚠ WHY A SEPARATE STAGE AT ALL, RATHER THAN LETTING THE COMPRESSORS DO IT.
 * Long-term drift — a narrator leaning in over a paragraph, a chapter that opens
 * loud — is minutes wide. A compressor with a release long enough to track that
 * pumps on speech, and one fast enough not to pump cannot see it. This removes
 * the drift so the compressors only ever see syllable-scale work.
 *
 * ── Two things this port does differently ───────────────────────────────────
 *
 * ⚠ 1. THE VOICED MASK COMES FROM ENERGY, NOT FROM SILERO. The server's default
 * backend is a neural VAD in a Python subprocess; there is none in the browser.
 * The substitute is NOT an invention: `frameAnalysis.js` ships an ENERGY BACKEND
 * as a first-class path (`VAD_BACKEND=energy`), used whenever Silero is
 * unavailable, and it is what is ported here — frame RMS against
 * `noiseFloor + 6 dB`, with the noise floor bootstrapped from the 20
 * lowest-energy frames.
 *
 * ⚠ IT IS STILL A REAL DIFFERENCE AND THE COST LANDS IN ONE PLACE. Silero
 * labels breaths and unvoiced fricatives as speech; an energy gate at
 * `noiseFloor + 6` labels the quiet ones as silence. That does not change a
 * clip's measured level — fricatives carry little energy, which is why they fall
 * under the gate — but it could FRAGMENT a clip, splitting a phrase at its own
 * "s". The hysteresis is what absorbs it: an unvoiced run shorter than
 * `VAD_MIN_UNVOICED_MS` (300 ms) is bridged, and speech fricatives are
 * essentially always shorter than that. A deliberate silence longer than 300 ms
 * is a real phrase boundary and should split a clip.
 *
 * ⚠ AND THIS IS A DIFFERENT SUBSTITUTION FROM VoiceRx's, WHICH IS NOT
 * INTERCHANGEABLE WITH IT. VoiceRx selects PITCHED frames with `F0Tracker`,
 * because its computation is about harmonic structure and wants exactly the
 * periodic frames. A leveller wants "is anyone talking", where an energy gate is
 * the closer proxy and a pitch tracker would drop every fricative outright.
 *
 * ⚠ 2. K-WEIGHTING COMES FROM `dsp/loudness.js`, not from a private copy of the
 * coefficients. Same filter, one definition, and it is the one whose sections
 * are re-derived per sample rate — so 44.1 kHz material is measured exactly
 * rather than through a 48 kHz table.
 *
 * ── Shape ───────────────────────────────────────────────────────────────────
 *
 * Analysis and rendering are split, and the split is what the apply path needs:
 *
 *   analyzeAutoLevel(channels, sampleRate, config) -> analysis   (WHOLE FILE)
 *   renderAutoLevelGainDb(analysis, startSample, numSamples)     (ANY SPAN)
 *
 * ⚠ THE ANALYSIS IS WHOLE-FILE AND THE RENDER IS PER-SPAN, DELIBERATELY. Clip
 * targets are a running median over neighbouring clips, so analysing only the
 * region would give one answer for a phrase and a different one for the
 * paragraph containing it — the same defect `inputAlignDbFor` warns about, and
 * worse here because the whole point is consistency ACROSS a recording. It also
 * means the offline apply path can evaluate the envelope over its PRE-ROLL as
 * well as its region, so the audio entering the composite's compressors is
 * already levelled at the region boundary instead of stepping there.
 *
 * No Web Audio, no DOM — hand it Float32Arrays.
 */

import { kWeightingSections, LOUDNESS_OFFSET_DB } from './loudness.js'
import { BiquadCascade } from './biquad.js'

// ── Constants, all matching server/pipeline/autoLeveler.js ──────────────────

/** Frame size for the voiced/silence decision, ms. Matches FRAME_DURATION_S. */
export const FRAME_MS = 25
/** Hop for the short-term loudness curve that drives sub-phrase splitting, ms. */
export const HOP_MS = 100

export const VAD_MIN_VOICED_MS = 200
export const VAD_MIN_UNVOICED_MS = 300

/** Lowest-energy frames used to bootstrap the noise floor. */
export const BOOTSTRAP_FRAMES = 20
/** How far above the bootstrapped noise floor a frame must sit to be voiced. */
export const SILENCE_MARGIN_DB = 6

export const SUBPHRASE_SPLIT_DROP_DB = 6.0
export const SUBPHRASE_SPLIT_MIN_DURATION_MS = 500
export const MIN_SUBCLIP_HOPS_FACTOR = 2

export const CROSSFADE_MS = 30
export const MERGE_MAX_DELTA_DB = 6.0

export const MIN_FILE_DURATION_S = 10
export const MIN_VOICED_DURATION_S = 5

/**
 * Defaults matching the server's `general_clean` autoLeveler config — the
 * middle of the three shipped settings.
 */
export const AUTO_LEVEL_DEFAULTS = Object.freeze({
  targetMode: 'running_median', // 'running_median' | 'global'
  targetWindowS: 30,
  noiseFloorTargetDbfs: -50,
  deadbandDb: 1.5,
  kneeDb: 1,
  maxUpDb: 6,
  maxDownDb: 8,
})

const DB_FLOOR = -120

function rmsToDbfs(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : DB_FLOOR
}

/** Frame f starts here. Time-based so boundaries line up across sample rates. */
function frameBoundary(f, sampleRate) {
  return Math.round(f * (FRAME_MS / 1000) * sampleRate)
}

// ── Mono sum and K-weighted power ───────────────────────────────────────────

/**
 * Sum of channels, for the energy gate.
 *
 * ⚠ SUM, NOT MEAN-OF-POWERS — the same distinction `gatedRmsOfChannels` records
 * paying for. A stereo file with one dead channel and a polarity-flipped pair
 * are the two cases that separate them, and both are ordinary recordings.
 */
function monoSum(channels, length) {
  const n = channels.length
  const out = new Float32Array(length)
  if (n === 0) return out
  const scale = 1 / n
  for (let ch = 0; ch < n; ch++) {
    const c = channels[ch]
    const m = Math.min(length, c.length)
    for (let i = 0; i < m; i++) out[i] += c[i] * scale
  }
  return out
}

/**
 * Prefix sum of K-weighted power, summed across channels per BS.1770.
 *
 * A prefix array makes "loudness of an arbitrary sample range" O(1), which is
 * what the clip measurement and the short-term curve both need — the server
 * builds the same thing for the same reason.
 */
function kWeightedPowerSum(channels, sampleRate, length) {
  const sections = kWeightingSections(sampleRate)
  const ps = new Float64Array(length + 1)
  const scratch = new Float32Array(length)

  for (const channel of channels) {
    const cascade = new BiquadCascade(sections.length, 1)
    cascade.setSections(sections)
    const src = channel.length >= length ? channel.subarray(0, length) : channel
    scratch.fill(0)
    cascade.process(src, scratch.subarray(0, src.length), src.length, 0)
    for (let i = 0; i < length; i++) ps[i + 1] += scratch[i] * scratch[i]
  }
  // Prefix-accumulate in place, now that every channel has contributed.
  for (let i = 0; i < length; i++) ps[i + 1] += ps[i]
  return ps
}

function meanSquareRange(powerSum, start, end) {
  if (end <= start) return 0
  return (powerSum[end] - powerSum[start]) / (end - start)
}

function lufsOf(meanSq) {
  return meanSq > 0 ? LOUDNESS_OFFSET_DB + 10 * Math.log10(meanSq) : DB_FLOOR
}

// ── Voiced mask ─────────────────────────────────────────────────────────────

/**
 * Per-frame voiced flags from energy alone, plus the bootstrapped noise floor.
 * The server's energy backend, ported exactly.
 */
export function voicedFramesByEnergy(mono, sampleRate) {
  const numFrames = Math.floor(mono.length / ((FRAME_MS / 1000) * sampleRate))
  if (numFrames === 0) {
    return { voiced: new Uint8Array(0), noiseFloorDbfs: DB_FLOOR, frameRms: new Float64Array(0) }
  }

  const frameRms = new Float64Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    const start = frameBoundary(f, sampleRate)
    const end = Math.min(mono.length, frameBoundary(f + 1, sampleRate))
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += mono[i] * mono[i]
    frameRms[f] = end > start ? Math.sqrt(sumSq / (end - start)) : 0
  }

  // Noise floor: RMS over the lowest-energy frames.
  const sorted = Float64Array.from(frameRms).sort()
  const take = Math.min(BOOTSTRAP_FRAMES, sorted.length)
  let sumSq = 0
  for (let i = 0; i < take; i++) sumSq += sorted[i] * sorted[i]
  const noiseFloorDbfs = rmsToDbfs(Math.sqrt(sumSq / take))
  const threshold = noiseFloorDbfs + SILENCE_MARGIN_DB

  const voiced = new Uint8Array(numFrames)
  for (let f = 0; f < numFrames; f++) {
    voiced[f] = rmsToDbfs(frameRms[f]) >= threshold ? 1 : 0
  }
  return { voiced, noiseFloorDbfs, frameRms }
}

/**
 * Two-pass hysteresis: drop voiced runs shorter than VAD_MIN_VOICED_MS, then
 * bridge unvoiced gaps shorter than VAD_MIN_UNVOICED_MS.
 *
 * ⚠ THE BRIDGING PASS IS WHAT MAKES THE ENERGY GATE USABLE HERE — see the note
 * at the top of this file. An unvoiced fricative is far shorter than 300 ms, so
 * it is bridged and the phrase stays one clip; a real pause is longer, and
 * should split one.
 *
 * Order matters and matches the server: dropping spurious voiced runs first
 * stops a single loud tick from anchoring a bridge across a genuine pause.
 */
export function applyVadHysteresis(voicedIn) {
  const n = voicedIn.length
  if (n === 0) return new Uint8Array(0)
  const minVoicedF = Math.max(1, Math.round(VAD_MIN_VOICED_MS / FRAME_MS))
  const minUnvoicedF = Math.max(1, Math.round(VAD_MIN_UNVOICED_MS / FRAME_MS))
  const voiced = Uint8Array.from(voicedIn)

  for (let f = 0; f < n;) {
    if (voiced[f] === 1) {
      let e = f
      while (e < n && voiced[e] === 1) e++
      if (e - f < minVoicedF) voiced.fill(0, f, e)
      f = e
    } else f++
  }
  for (let f = 0; f < n;) {
    if (voiced[f] === 0) {
      let e = f
      while (e < n && voiced[e] === 0) e++
      if (e - f < minUnvoicedF) voiced.fill(1, f, e)
      f = e
    } else f++
  }
  return voiced
}

/** Any voiced frame inside a hop makes the hop voiced. */
function frameVoicedToHopVoiced(voiced, framesPerHop, numHops) {
  const hopVoiced = new Uint8Array(numHops)
  for (let h = 0; h < numHops; h++) {
    const f0 = h * framesPerHop
    for (let k = 0; k < framesPerHop; k++) {
      if (f0 + k < voiced.length && voiced[f0 + k]) { hopVoiced[h] = 1; break }
    }
  }
  return hopVoiced
}

// ── Gain law ────────────────────────────────────────────────────────────────

/**
 * Drift correction with a deadband and a smoothstep knee, clamped per direction.
 *
 * ⚠ THE DEADBAND IS NOT A THRESHOLD AND THE KNEE IS NOT A RATIO. Inside the
 * deadband the correction is exactly zero, so a file already level is left
 * bit-identical rather than nudged. Past it the correction is `delta - deadband`
 * — it closes the excess, not the whole gap — which is what keeps a clip that is
 * 1.6 dB out from being yanked all the way to the median.
 */
export function shapeDrift(delta, deadbandDb, kneeDb, maxUpDb, maxDownDb) {
  const abs = Math.abs(delta)
  const sign = delta >= 0 ? 1 : -1
  let g
  if (abs < deadbandDb) g = 0
  else if (kneeDb > 0 && abs <= deadbandDb + kneeDb) {
    const x = (abs - deadbandDb) / kneeDb
    g = sign * (x * x * (3 - 2 * x)) * (abs - deadbandDb)
  } else g = sign * (abs - deadbandDb)
  return g > 0 ? Math.min(g, maxUpDb) : Math.max(g, -maxDownDb)
}

// ── Clip detection ──────────────────────────────────────────────────────────

function vadRunsToClips(hopVoiced, hopSamples, totalSamples) {
  const clips = []
  const n = hopVoiced.length
  for (let h = 0; h < n;) {
    if (hopVoiced[h] === 1) {
      let e = h
      while (e < n && hopVoiced[e] === 1) e++
      clips.push({
        hopStart: h, hopEnd: e,
        sampleStart: h * hopSamples,
        sampleEnd: Math.min(e * hopSamples, totalSamples),
      })
      h = e
    } else h++
  }
  return clips
}

/**
 * Split a voiced run at a sustained internal level drop — a phrase boundary the
 * VAD did not see because the speaker never stopped making sound.
 */
function splitClipBySubphrase(clip, shortTerm, hopSamples, totalSamples, dropDb, minHops) {
  const { hopStart, hopEnd } = clip
  if (hopEnd - hopStart < MIN_SUBCLIP_HOPS_FACTOR * minHops) return [clip]

  const vals = []
  for (let h = hopStart; h < hopEnd; h++) {
    if (Number.isFinite(shortTerm[h])) vals.push(shortTerm[h])
  }
  if (vals.length < 2) return [clip]
  vals.sort((a, b) => a - b)
  const mid = Math.floor(vals.length / 2)
  const median = vals.length % 2 === 0 ? (vals[mid - 1] + vals[mid]) / 2 : vals[mid]
  const dropThreshold = median - dropDb

  let bestHop = -1
  let bestVal = Infinity
  let regionStart = -1
  for (let h = hopStart; h <= hopEnd; h++) {
    const below = h < hopEnd && Number.isFinite(shortTerm[h]) && shortTerm[h] < dropThreshold
    if (below && regionStart < 0) regionStart = h
    else if (!below && regionStart >= 0) {
      if (h - regionStart >= minHops) {
        let localHop = regionStart
        let localVal = shortTerm[regionStart]
        for (let k = regionStart; k < h; k++) {
          if (shortTerm[k] < localVal) { localVal = shortTerm[k]; localHop = k }
        }
        if (localVal < bestVal) { bestVal = localVal; bestHop = localHop }
      }
      regionStart = -1
    }
  }
  if (bestHop < 0) return [clip]
  if (bestHop - hopStart < minHops || hopEnd - bestHop < minHops) return [clip]

  const mk = (a, b) => ({
    hopStart: a, hopEnd: b,
    sampleStart: a * hopSamples,
    sampleEnd: Math.min(b * hopSamples, totalSamples),
  })
  return [
    ...splitClipBySubphrase(mk(hopStart, bestHop), shortTerm, hopSamples, totalSamples, dropDb, minHops),
    ...splitClipBySubphrase(mk(bestHop, hopEnd), shortTerm, hopSamples, totalSamples, dropDb, minHops),
  ]
}

// ── Weighted statistics ─────────────────────────────────────────────────────

function weightedMedian(values, weights) {
  const n = values.length
  if (n === 0) return NaN
  if (n === 1) return values[0]
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b])
  let totalW = 0
  for (let i = 0; i < n; i++) totalW += weights[i]
  if (totalW <= 0) return values[order[Math.floor(n / 2)]]
  let cum = 0
  for (let i = 0; i < n; i++) {
    cum += weights[order[i]]
    if (cum >= totalW / 2) return values[order[i]]
  }
  return values[order[n - 1]]
}

function weightedStd(values, weights) {
  const n = values.length
  if (n < 2) return 0
  let totalW = 0
  let mean = 0
  for (let i = 0; i < n; i++) { totalW += weights[i]; mean += values[i] * weights[i] }
  if (totalW <= 0) return 0
  mean /= totalW
  let varSum = 0
  for (let i = 0; i < n; i++) varSum += weights[i] * (values[i] - mean) ** 2
  return Math.sqrt(varSum / totalW)
}

function computeClipTargets(clipLufs, durations, sampleStarts, windowS, sampleRate, mode) {
  const n = clipLufs.length
  const out = new Float64Array(n)
  const globalTarget = weightedMedian(clipLufs, durations)
  if (mode === 'global' || n < 2) { out.fill(globalTarget); return out }

  const windowSamples = Math.round(windowS * sampleRate)
  for (let k = 0; k < n; k++) {
    const vals = []
    const wts = []
    const cutoff = sampleStarts[k] - windowSamples
    for (let j = 0; j <= k; j++) {
      if (sampleStarts[j] >= cutoff) { vals.push(clipLufs[j]); wts.push(durations[j]) }
    }
    out[k] = vals.length >= 2 ? weightedMedian(vals, wts) : globalTarget
  }
  return out
}

// ── Merge and crossfade ─────────────────────────────────────────────────────

/**
 * Merge adjacent clips whose gains disagree by more than MERGE_MAX_DELTA_DB.
 *
 * ⚠ THE TRANSPARENT FALLBACK, AND IT IS NOT A SAFETY CLAMP. A large step between
 * neighbouring clips is audible as a level jump however well the crossfade is
 * placed, so the stage gives up the correction rather than make an artefact: the
 * two become one clip at their duration-weighted average.
 */
function mergeClipsForGainConflict(clipsIn, gainsIn, maxDeltaDb) {
  const clips = clipsIn.map(c => ({ ...c }))
  const gains = Array.from(gainsIn)
  const durs = clips.map(c => c.sampleEnd - c.sampleStart)
  let merges = 0
  let changed = true
  while (changed) {
    changed = false
    for (let k = 0; k < clips.length - 1; k++) {
      if (Math.abs(gains[k + 1] - gains[k]) > maxDeltaDb) {
        const merged = {
          hopStart: clips[k].hopStart, hopEnd: clips[k + 1].hopEnd,
          sampleStart: clips[k].sampleStart, sampleEnd: clips[k + 1].sampleEnd,
        }
        const g = (gains[k] * durs[k] + gains[k + 1] * durs[k + 1]) / (durs[k] + durs[k + 1])
        clips.splice(k, 2, merged)
        gains.splice(k, 2, g)
        durs.splice(k, 2, merged.sampleEnd - merged.sampleStart)
        merges++
        changed = true
        break
      }
    }
  }
  return { clips, gains, merges }
}

function findLowestEnergyWindow(powerSum, fromSample, toSample, windowSamples, totalSamples) {
  const lo = Math.max(0, fromSample)
  const hi = Math.min(totalSamples, toSample)
  const win = Math.max(1, Math.min(windowSamples, hi - lo))
  if (hi - lo <= win) return lo
  const stride = Math.max(1, Math.floor(win / 4))
  let bestStart = lo
  let bestEnergy = Infinity
  for (let s = lo; s + win <= hi; s += stride) {
    const e = meanSquareRange(powerSum, s, s + win)
    if (e < bestEnergy) { bestEnergy = e; bestStart = s }
  }
  return bestStart
}

/**
 * Where each clip-to-clip transition happens.
 *
 * ⚠ PLACED AT THE QUIETEST POINT IN THE GAP, NOT AT THE CLIP BOUNDARY. A gain
 * change is inaudible under silence and obvious under speech, so the transition
 * is moved to wherever there is least signal to reveal it.
 */
/**
 * The ramp from 0 dB into the FIRST clip's gain.
 *
 * ⚠ THE SERVER HAS NO EQUIVALENT AND STEPS INSTEAD, AND THIS PORT DELIBERATELY
 * DIVERGES. `buildSampleGainArray` there fills everything before the first clip
 * with 0 dB and the clip itself with its own gain, so the envelope jumps by the
 * whole of that gain on one sample — measured here at 6.00 dB, landing exactly
 * at the first clip's start, which is where the first word begins.
 *
 * ⚠ AND EVERY ACX FILE HITS IT, which is what makes it worth diverging over
 * rather than matching: `roomTonePad` exists to put 0.75 s of room tone at the
 * head of a narration file, so "leading silence before the first clip" is not an
 * edge case, it is the house style for the beachhead audience.
 *
 * The fix reuses the rule the other boundaries already follow — the quietest
 * crossfade-length window in the silence ahead of the clip — so a head ramp and
 * a clip-to-clip transition are the same mechanism, not two.
 *
 * Null when the first clip starts at sample 0: there is nothing before it to
 * step from, so the envelope simply begins at that clip's gain.
 */
function buildHeadPlan(clips, gains, powerSum, crossfadeSamples, totalSamples) {
  const first = clips[0]
  if (!first || first.sampleStart <= 0) return null
  const start = findLowestEnergyWindow(
    powerSum, 0, first.sampleStart, crossfadeSamples, totalSamples,
  )
  return {
    startSample: start,
    endSample: Math.min(first.sampleStart, start + crossfadeSamples),
    fromGain: 0,
    toGain: gains[0],
  }
}

function buildCrossfadePlans(clips, gains, powerSum, crossfadeSamples, totalSamples) {
  const plans = []
  for (let k = 0; k < clips.length - 1; k++) {
    const a = clips[k]
    const b = clips[k + 1]
    const start = b.sampleStart > a.sampleEnd
      ? findLowestEnergyWindow(powerSum, a.sampleEnd, b.sampleStart, crossfadeSamples, totalSamples)
      : Math.max(0, a.sampleEnd - Math.floor(crossfadeSamples / 2))
    plans.push({
      startSample: start,
      endSample: Math.min(totalSamples, start + crossfadeSamples),
      fromGain: gains[k],
      toGain: gains[k + 1],
    })
  }
  return plans
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Analyse a WHOLE FILE and produce the clip plan.
 *
 * @param {Float32Array[]} channels whole-file audio
 * @param {number} sampleRate
 * @param {object} [config] overrides over AUTO_LEVEL_DEFAULTS
 * @returns {{
 *   applied: boolean, skippedReason: string|null,
 *   clips: Array<{sampleStart:number,sampleEnd:number}>, gainsDb: number[],
 *   crossfadePlans: Array<object>, totalSamples: number,
 *   noiseFloorDbfs: number, clipStdDb: number, merges: number,
 *   subphraseSplits: number, maxUpDbEffective: number,
 * }}
 */
export function analyzeAutoLevel(channels, sampleRate, config = {}) {
  const cfg = { ...AUTO_LEVEL_DEFAULTS, ...config }
  const totalSamples = channels?.[0]?.length ?? 0

  const skip = (reason) => ({
    applied: false, skippedReason: reason, clips: [], gainsDb: [],
    crossfadePlans: [], totalSamples, noiseFloorDbfs: DB_FLOOR,
    clipStdDb: 0, merges: 0, subphraseSplits: 0, maxUpDbEffective: cfg.maxUpDb,
  })

  if (!channels || channels.length === 0 || totalSamples === 0) return skip('empty')
  if (totalSamples < MIN_FILE_DURATION_S * sampleRate) return skip('file_too_short')

  const mono = monoSum(channels, totalSamples)
  const { voiced: rawVoiced, noiseFloorDbfs } = voicedFramesByEnergy(mono, sampleRate)
  const voiced = applyVadHysteresis(rawVoiced)

  let voicedFrames = 0
  for (let i = 0; i < voiced.length; i++) voicedFrames += voiced[i]
  if (voicedFrames * (FRAME_MS / 1000) < MIN_VOICED_DURATION_S) return skip('not_enough_voiced')

  const hopSamples = Math.max(1, Math.round((HOP_MS / 1000) * sampleRate))
  const numHops = Math.floor(totalSamples / hopSamples)
  if (numHops < 2) return skip('file_too_short')
  const framesPerHop = Math.max(1, Math.round(HOP_MS / FRAME_MS))
  const hopVoiced = frameVoicedToHopVoiced(voiced, framesPerHop, numHops)

  const kwPowerSum = kWeightedPowerSum(channels, sampleRate, totalSamples)

  // Short-term loudness per hop, for sub-phrase splitting. One hop's own window
  // — the server uses the same span for this curve.
  const shortTerm = new Float64Array(numHops)
  for (let h = 0; h < numHops; h++) {
    const a = h * hopSamples
    shortTerm[h] = lufsOf(meanSquareRange(kwPowerSum, a, Math.min(a + hopSamples, totalSamples)))
  }

  const minHops = Math.max(1, Math.round(SUBPHRASE_SPLIT_MIN_DURATION_MS / HOP_MS))
  const baseClips = vadRunsToClips(hopVoiced, hopSamples, totalSamples)
  const clips = []
  let subphraseSplits = 0
  for (const clip of baseClips) {
    const sub = splitClipBySubphrase(
      clip, shortTerm, hopSamples, totalSamples, SUBPHRASE_SPLIT_DROP_DB, minHops,
    )
    subphraseSplits += sub.length - 1
    clips.push(...sub)
  }
  if (clips.length === 0) return skip('no_clips')

  const clipLufs = clips.map(c => lufsOf(meanSquareRange(kwPowerSum, c.sampleStart, c.sampleEnd)))
  const durations = clips.map(c => c.sampleEnd - c.sampleStart)
  const sampleStarts = clips.map(c => c.sampleStart)

  /**
   * ⚠ THE SKIP IS TIED TO THE DEADBAND, NOT TO A SEPARATE NUMBER. If the spread
   * across clips is already inside the deadband then every clip would solve to
   * exactly zero, and the stage would run in full to produce an identity. Tying
   * the two keeps "already level" meaning one thing.
   */
  const clipStdDb = weightedStd(clipLufs, durations)
  if (clipStdDb < cfg.deadbandDb) {
    return { ...skip('file_already_leveled'), noiseFloorDbfs, clipStdDb }
  }

  /**
   * ⚠ THE NOISE FLOOR CAPS HOW FAR ANYTHING MAY BE RAISED. Lifting a quiet clip
   * lifts its room tone with it, and a leveller that hands the user a louder
   * noise floor than they started with has made the file worse in the one
   * dimension ACX actually measures. 3 dB of margin below the target.
   */
  const nfHeadroom = Math.max(0, (cfg.noiseFloorTargetDbfs - noiseFloorDbfs) - 3)
  const maxUpDbEffective = Math.min(cfg.maxUpDb, nfHeadroom)

  const targets = computeClipTargets(
    clipLufs, durations, sampleStarts, cfg.targetWindowS, sampleRate, cfg.targetMode,
  )
  const rawGains = clipLufs.map((lufs, k) => shapeDrift(
    targets[k] - lufs, cfg.deadbandDb, cfg.kneeDb, maxUpDbEffective, cfg.maxDownDb,
  ))

  const merged = mergeClipsForGainConflict(clips, rawGains, MERGE_MAX_DELTA_DB)
  const crossfadeSamples = Math.max(1, Math.round((CROSSFADE_MS / 1000) * sampleRate))
  const crossfadePlans = buildCrossfadePlans(
    merged.clips, merged.gains, kwPowerSum, crossfadeSamples, totalSamples,
  )
  const headPlan = buildHeadPlan(
    merged.clips, merged.gains, kwPowerSum, crossfadeSamples, totalSamples,
  )

  return {
    applied: true,
    skippedReason: null,
    clips: merged.clips,
    gainsDb: merged.gains,
    crossfadePlans,
    headPlan,
    totalSamples,
    noiseFloorDbfs,
    clipStdDb,
    merges: merged.merges,
    subphraseSplits,
    maxUpDbEffective,
  }
}

/**
 * The gain envelope, in dB, over an arbitrary span of the analysed file.
 *
 * ⚠ ANY SPAN, INCLUDING ONE THAT STARTS BEFORE THE REGION BEING APPLIED. That is
 * the whole reason this is separate from the analysis: the offline apply path
 * renders a pre-roll ahead of its region, and that pre-roll has to carry the
 * same gain the preview gave it or the compressors downstream meet a step
 * exactly where the region begins.
 *
 * Outside the analysed file the envelope holds its edge value (0 dB before the
 * first clip, the last clip's gain after it), matching what the preview's
 * modulator does when it runs past its buffer.
 *
 * @param {object} analysis result of analyzeAutoLevel
 * @param {number} startSample first sample of the span, may be negative
 * @param {number} numSamples
 * @returns {Float32Array} per-sample gain in dB
 */
export function renderAutoLevelGainDb(analysis, startSample, numSamples) {
  const out = new Float32Array(numSamples)
  if (!analysis?.applied || analysis.clips.length === 0) return out

  const { clips, gainsDb, crossfadePlans, headPlan } = analysis
  const lastGain = gainsDb[gainsDb.length - 1]
  const lastEnd = clips[clips.length - 1].sampleEnd
  const firstStart = clips[0].sampleStart

  /**
   * ⚠ A CURSOR, NOT A SEARCH PER SAMPLE. The obvious implementation asks "which
   * clip is sample i in" for every sample, which is O(samples x clips) — on a
   * 60 s file with 100 clips that is 260 million comparisons to produce one
   * envelope, and the envelope is rebuilt on every apply. Samples are requested
   * in order, so the clip index only ever moves forward.
   */
  let k = 0
  for (let n = 0; n < numSamples; n++) {
    const i = startSample + n

    if (i >= lastEnd) { out[n] = lastGain; continue }
    if (i < firstStart) {
      // Head: 0 dB, then the ramp into the first clip's gain.
      out[n] = headPlan == null ? gainsDb[0]
        : i < headPlan.startSample ? 0
          : i >= headPlan.endSample ? headPlan.toGain
            : blend(headPlan, i)
      continue
    }

    // Advance to the clip containing i, or to the first clip starting after it.
    while (k < clips.length - 1 && i >= clips[k].sampleEnd) k++
    // A span can start mid-file, so the cursor may also need to move BACK on
    // the first sample; after that it only advances.
    while (k > 0 && i < clips[k].sampleStart && i < clips[k - 1].sampleEnd) k--

    const clip = clips[k]
    if (i < clip.sampleStart) {
      // In the gap before clip k — plan k-1 carries the transition into it.
      const plan = crossfadePlans[k - 1]
      out[n] = plan == null ? gainsDb[k]
        : i < plan.startSample ? plan.fromGain
          : i >= plan.endSample ? plan.toGain
            : blend(plan, i)
      continue
    }

    // Inside clip k, unless a crossfade window reaches in over it from either
    // side — a window placed at a voiced-adjacent boundary straddles the join.
    const before = k > 0 ? crossfadePlans[k - 1] : null
    if (before && i >= before.startSample && i < before.endSample) {
      out[n] = blend(before, i)
      continue
    }
    const after = k < crossfadePlans.length ? crossfadePlans[k] : null
    if (after && i >= after.startSample && i < after.endSample) {
      out[n] = blend(after, i)
      continue
    }
    out[n] = gainsDb[k]
  }
  return out
}

/** Cosine blend across one crossfade plan. */
function blend(plan, i) {
  const len = plan.endSample - plan.startSample
  if (len <= 0) return plan.toGain
  const t = (i - plan.startSample) / len
  const w = 0.5 - 0.5 * Math.cos(Math.PI * t)
  return plan.fromGain * (1 - w) + plan.toGain * w
}

/**
 * Convenience: the envelope as a linear multiplier for the whole analysed file.
 * Preview drives an AudioParam from this; see the de-esser for that pattern.
 */
export function renderAutoLevelGainLinear(analysis, startSample, numSamples) {
  const db = renderAutoLevelGainDb(analysis, startSample, numSamples)
  const out = new Float32Array(db.length)
  for (let i = 0; i < db.length; i++) out[i] = Math.pow(10, db[i] / 20)
  return out
}
