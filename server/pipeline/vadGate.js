/**
 * VAD Gate — silence-floor attenuator driven by VAD frame labels.
 *
 * Converts the binary voiced/silence frame labels from Silero VAD into a smooth
 * per-sample gain envelope and applies it to every channel. The envelope is
 * shaped by four parameters that work together to avoid the click/word-chop
 * pathology of a naive binary gate:
 *
 *   lookaheadMs      — open the gate this many ms BEFORE the voiced frame starts,
 *                      catching word onsets that begin partway through a frame.
 *   holdMs           — keep the gate open this many ms AFTER the last voiced frame,
 *                      catching word tails (consonant releases, breathy decays) that
 *                      extend past the VAD's voiced classification.
 *   attackMs         — one-pole rise time when the target transitions silence→open.
 *   releaseMs        — one-pole fall time when the target transitions open→silence.
 *   energyOverrideDb — dB above the measured noise floor; silence-labeled frames
 *                      with RMS at or above this level are treated as voiced,
 *                      catching soft fricative onsets ("s", "f") that Silero
 *                      mislabels. Set to null in a preset config to disable.
 *   minSilenceMs     — post-expansion silence gaps shorter than this (ms) are
 *                      bridged by merging the flanking segments (gap fill). This
 *                      catches multi-frame mislabeled runs that energy override
 *                      alone cannot recover because the onset energy is too low.
 *   minVoicedMs      — voiced segments shorter than this (ms) are dropped after
 *                      gap fill (removes isolated noise transients that energy
 *                      override may have opened). Real onsets adjacent to a voiced
 *                      body are never affected — gap fill merges them first.
 *
 * The gate never closes fully — `floorDb` sets the residual gain so silence
 * regions retain a faint room tone rather than collapsing to digital silence.
 *
 * Performance notes:
 *   - The prototype build_vad_gate_envelope() in the design doc allocates four
 *     full-length sample buffers (np.repeat, np.roll, maximum_filter1d, and the
 *     IIR output). This implementation collapses all four passes into a single
 *     O(N) walk: voiced frame ranges → segment list with lookahead/hold applied
 *     as integer offsets (no max-filter pass needed) → asymmetric IIR smoothing
 *     and floor mapping inlined while applying the gain to each channel.
 *   - Memory: O(numFrames) for the segment list (≪ numSamples) plus the output
 *     channel buffers. No intermediate envelope buffer is materialised.
 *
 * Chain position: after vocalExpander and before normalize. The expander
 * already attenuates silence-floor residual via a soft ratio — the VAD gate is
 * a complementary, harder cut for files where deeper silence is desired.
 */

import { readWavAllChannels } from './wavReader.js'
import { writeWavChannels }   from './wavWriter.js'

// Default parameters; each preset's vadGate config can override any subset.
const DEFAULTS = {
  lookaheadMs:      20,
  holdMs:           80,
  attackMs:         8,
  releaseMs:        40,
  floorDb:          -60,
  energyOverrideDb: 8,    // dB above noise floor; null to disable
  minSilenceMs:     150,  // bridge post-expansion gaps shorter than this
  minVoicedMs:      30,   // drop isolated voiced segments shorter than this
}

/**
 * Apply the VAD gate to an audio file.
 *
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Object|null|undefined} config - The vadGate config to use, taken from
 *   the merged ctx.preset (NOT looked up from the global PRESETS table) so any
 *   per-request override flows through. When falsy or `enabled !== true` the
 *   stage copies the input through and returns `applied: false`.
 * @param {import('./stages.js').AudioMetrics} frameAnalysis
 * @returns {Promise<VadGateResult>}
 *
 * @typedef {Object} VadGateResult
 * @property {boolean} applied
 * @property {string|null} [reason]
 * @property {number} [lookaheadMs]
 * @property {number} [holdMs]
 * @property {number} [attackMs]
 * @property {number} [releaseMs]
 * @property {number} [floorDb]
 * @property {number|null} [energyOverrideDb]       - Threshold used (dB above noise floor); null if disabled
 * @property {number} [minSilenceMs]                - Gap fill threshold (ms)
 * @property {number} [minVoicedMs]                 - Min segment duration before drop (ms)
 * @property {number} [voicedFrames]
 * @property {number} [silenceFrames]
 * @property {number} [energyOverriddenFrames]      - Frames rescued from silence label by energy override
 * @property {number} [openSegments]
 * @property {number} [pctSamplesAtFloor]           - % of samples at or near the floor
 */
export async function applyVadGate(inputPath, outputPath, config, frameAnalysis) {
  if (!config?.enabled) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'preset_not_configured' }
  }

  const frames = frameAnalysis?.frames
  if (!frames || frames.length === 0) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'no_vad_frames' }
  }

  const params = { ...DEFAULTS, ...config }
  const { channels, sampleRate, numSamples } = await readWavAllChannels(inputPath)

  // Skip when there are no voiced frames — the gate would just attenuate the
  // entire file to the floor, which is almost never what the user wants.
  let voicedCount = 0
  for (const f of frames) if (!f.isSilence) voicedCount++
  if (voicedCount === 0) {
    await copyThrough(inputPath, outputPath)
    return { applied: false, reason: 'no_voiced_frames' }
  }

  const lookaheadSamples = Math.max(0, Math.round(params.lookaheadMs * sampleRate / 1000))
  const holdSamples      = Math.max(0, Math.round(params.holdMs      * sampleRate / 1000))
  // Use sample-count time constants so the IIR coefficients match perceived ms.
  const attackTau  = Math.max(1, params.attackMs  * sampleRate / 1000)
  const releaseTau = Math.max(1, params.releaseMs * sampleRate / 1000)
  const attackCoeff  = 1 - Math.exp(-1 / attackTau)
  const releaseCoeff = 1 - Math.exp(-1 / releaseTau)
  const floorLinear  = Math.pow(10, params.floorDb / 20)
  const span         = 1 - floorLinear

  // ── Energy override ──────────────────────────────────────────────────────────
  // Silence-labeled frames whose rmsDbfs ≥ (noiseFloor + energyOverrideDb) are
  // treated as voiced. Catches soft fricative onsets ("s", "f") that Silero
  // mislabels — these have energy clearly above the noise floor even when the
  // neural model calls them silence. Disabled when energyOverrideDb is null.
  const noiseFloorDbfs = frameAnalysis?.noiseFloorDbfs ?? -60
  const energyOverrideThreshDb = params.energyOverrideDb != null
    ? noiseFloorDbfs + params.energyOverrideDb
    : Infinity

  // ── Gap fill and min voiced segment parameters ───────────────────────────────
  // minSilenceSamples: post-expansion gaps shorter than this are bridged.
  // minVoicedSamples:  segments shorter than this are dropped (after gap fill).
  const minSilenceSamples = Math.max(0, Math.round(params.minSilenceMs * sampleRate / 1000))
  const minVoicedSamples  = Math.max(0, Math.round(params.minVoicedMs  * sampleRate / 1000))

  // ── 1. Build voiced segments at sample resolution ────────────────────────
  // Frames are emitted in index order with uniform lengthSamples, but we read
  // offsetSamples directly so we tolerate any irregularities. Each segment is
  // [openStart, closeEnd] after applying lookahead (-) and hold (+). Segments
  // that overlap after expansion are merged on the fly.
  //
  // Trailing partial frame: frameAnalysis emits floor(samples / frameLength)
  // frames, so the last (samples % frameLength) samples are not classified.
  // When the final classified frame is voiced we extend its sample-range end
  // to numSamples so the partial-tail inherits the voiced state — otherwise
  // those samples fall outside every segment and the IIR ramps them down to
  // the floor, shaving final consonants from outros that end mid-frame.

  const lastFrame      = frames[frames.length - 1]
  const lastFrameEnd   = lastFrame.offsetSamples + lastFrame.lengthSamples
  const trailingVoiced = !lastFrame.isSilence && numSamples > lastFrameEnd

  const segments = []  // packed pairs: [s0, e0, s1, e1, ...]
  let curStart = -1
  let curEnd   = -1
  let energyOverrideCount = 0

  for (const frame of frames) {
    const energyOverride = frame.isSilence && frame.rmsDbfs >= energyOverrideThreshDb
    if (frame.isSilence && !energyOverride) continue
    if (energyOverride) energyOverrideCount++
    const fStart = frame.offsetSamples
    const fEnd   = (frame === lastFrame && trailingVoiced)
      ? numSamples
      : frame.offsetSamples + frame.lengthSamples

    // Coalesce consecutive voiced frames into a single segment before applying
    // expansion offsets so that hold/lookahead are not applied within a span.
    if (curEnd === frame.offsetSamples) {
      curEnd = fEnd
    } else {
      if (curStart >= 0) pushExpanded(segments, curStart, curEnd, lookaheadSamples, holdSamples, numSamples)
      curStart = fStart
      curEnd   = fEnd
    }
  }
  if (curStart >= 0) pushExpanded(segments, curStart, curEnd, lookaheadSamples, holdSamples, numSamples)

  // ── 1b. Gap fill ─────────────────────────────────────────────────────────────
  // Bridge post-expansion gaps shorter than minSilenceMs. Runs before min-voiced
  // drop so short leading/trailing segments coalesce with their neighbour first.
  if (minSilenceSamples > 0) mergeShortGaps(segments, minSilenceSamples)

  // ── 1c. Min voiced segment drop ───────────────────────────────────────────────
  // After gap fill, only genuinely isolated short bursts remain — drop them.
  if (minVoicedSamples > 0) dropShortSegments(segments, minVoicedSamples)

  const numSegments = segments.length / 2

  // ── 2. Single-pass envelope smoothing + gain application ─────────────────
  // Walk samples once. `segIdx` advances monotonically through the segment
  // list. The target is 1.0 inside an open segment, 0.0 elsewhere. The IIR
  // produces a smooth envelope; we map [0, 1] → [floor, 1] inline and multiply
  // every channel sample as we go. No intermediate envelope array allocated.

  let envelope = 0
  let segIdx = 0
  let segStart = numSegments > 0 ? segments[0]     : Infinity
  let segEnd   = numSegments > 0 ? segments[1]     : Infinity
  let nearFloorCount = 0
  // Threshold for "at or near the floor" reporting: within 0.5 dB of floor.
  const nearFloorLinear = Math.pow(10, (params.floorDb + 0.5) / 20)

  const numChannels = channels.length
  const output = channels.map(() => new Float32Array(numSamples))

  for (let i = 0; i < numSamples; i++) {
    // Advance segment cursor past any segments whose close has been crossed.
    while (i >= segEnd && segIdx < numSegments - 1) {
      segIdx++
      segStart = segments[2 * segIdx]
      segEnd   = segments[2 * segIdx + 1]
    }
    const target = (i >= segStart && i < segEnd) ? 1 : 0

    const coeff = target > envelope ? attackCoeff : releaseCoeff
    envelope += coeff * (target - envelope)

    const gain = floorLinear + envelope * span
    if (gain <= nearFloorLinear) nearFloorCount++

    for (let ch = 0; ch < numChannels; ch++) {
      output[ch][i] = channels[ch][i] * gain
    }
  }

  await writeWavChannels(output, sampleRate, outputPath)

  return {
    applied:                true,
    lookaheadMs:            params.lookaheadMs,
    holdMs:                 params.holdMs,
    attackMs:               params.attackMs,
    releaseMs:              params.releaseMs,
    floorDb:                params.floorDb,
    energyOverrideDb:       params.energyOverrideDb ?? null,
    minSilenceMs:           params.minSilenceMs,
    minVoicedMs:            params.minVoicedMs,
    voicedFrames:           voicedCount,
    silenceFrames:          frames.length - voicedCount,
    energyOverriddenFrames: energyOverrideCount,
    openSegments:           numSegments,
    pctSamplesAtFloor:      numSamples > 0 ? round2(100 * nearFloorCount / numSamples) : 0,
  }
}

/**
 * Append a voiced segment to the packed [start,end,...] list, applying
 * lookahead/hold expansion and merging with the previous segment when the
 * expanded range overlaps. Clamps to [0, numSamples].
 */
function pushExpanded(segments, fStart, fEnd, lookaheadSamples, holdSamples, numSamples) {
  const s = Math.max(0, fStart - lookaheadSamples)
  const e = Math.min(numSamples, fEnd + holdSamples)
  if (segments.length > 0 && s <= segments[segments.length - 1]) {
    // Overlap with the previous segment's close — extend it.
    if (e > segments[segments.length - 1]) segments[segments.length - 1] = e
    return
  }
  segments.push(s, e)
}

/**
 * Bridge post-expansion gaps between adjacent segments that are shorter than
 * minSilenceSamples. Runs before dropShortSegments so that short leading or
 * trailing segments belonging to a nearby voiced body can coalesce into it
 * before the length check fires. Operates in-place on the packed [s0,e0,...]
 * array.
 */
function mergeShortGaps(segments, minSilenceSamples) {
  if (segments.length < 4) return
  let w = 0  // write cursor (segment index, not flat index)
  for (let r = 1; r < segments.length / 2; r++) {
    const prevEnd   = segments[w * 2 + 1]
    const nextStart = segments[r * 2]
    if (nextStart - prevEnd < minSilenceSamples) {
      // Gap is shorter than threshold — extend the current write segment.
      segments[w * 2 + 1] = segments[r * 2 + 1]
    } else {
      w++
      segments[w * 2]     = segments[r * 2]
      segments[w * 2 + 1] = segments[r * 2 + 1]
    }
  }
  segments.length = (w + 1) * 2
}

/**
 * Remove voiced segments shorter than minVoicedSamples. After gap fill, only
 * genuinely isolated short segments (noise transients, click bursts) remain —
 * real word onsets adjacent to a voiced body have already been merged into it.
 * Operates in-place on the packed [s0,e0,...] array.
 */
function dropShortSegments(segments, minVoicedSamples) {
  let w = 0
  for (let r = 0; r < segments.length / 2; r++) {
    const s = segments[r * 2]
    const e = segments[r * 2 + 1]
    if (e - s >= minVoicedSamples) {
      segments[w * 2]     = s
      segments[w * 2 + 1] = e
      w++
    }
  }
  segments.length = w * 2
}

async function copyThrough(inputPath, outputPath) {
  const { readFile, writeFile } = await import('fs/promises')
  await writeFile(outputPath, await readFile(inputPath))
}

function round2(n) {
  return Math.round(n * 100) / 100
}
