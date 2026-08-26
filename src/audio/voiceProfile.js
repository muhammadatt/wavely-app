/**
 * What this speaker's pitch is, for anything that needs to aim at a voice.
 *
 * ONE TRACKER, ONE GATE, ONE POPULATION. This runs VoiceRx's own
 * `collectVoicedFrames` rather than a private F0 pass, so the median pitch the
 * resonance zones are placed from is the SAME NUMBER VoiceRx classifies the
 * voice with, by construction rather than by two implementations agreeing. Two
 * pitch estimates on one file that disagree by an octave-halving error would
 * put VoiceRx's regions and ResoTame's zones in different places on the same
 * spectrum, and nothing on either panel would say so.
 *
 * It costs more than an F0-only pass would: `collectVoicedFrames` also computes
 * frame energies and assembles the frame list. The frames are subarray VIEWS,
 * so no audio is copied, and the measurement runs in the worker off a region
 * already capped at 30 s — the price is one energy pass over the region, paid
 * once per press of a button, which is worth it for the guarantee above.
 *
 * ⚠ THE F0 TRACKER'S SEARCH IS 70-400 Hz. A speaker outside it is reported as
 * whatever lands nearest the edge, which for the placement means a boundary set
 * scaled toward the end of the male/female interpolation rather than a wrong
 * one — but it is not a measurement of that voice. See dsp/f0.js on why a peak
 * pinned to the edge of the search window is only trusted when it is a genuine
 * local maximum.
 */

import { collectVoicedFrames, percentile, MIN_VOICED_FRAMES } from './voicerx/analysis.js'
import { rumbleCornerHz } from './voicerx/rumble.js'

/**
 * Median F0 and the sub-fundamental corner for a region.
 *
 * The corner is `rumbleCornerHz`'s, unchanged and not re-derived: "where this
 * speaker's voice stops" has one definition in this codebase and two would
 * eventually disagree. It is prophylactic rather than measured — 0.75 x p25 F0
 * or 0.55 x median, whichever is lower, clamped to [40, 100] Hz — because the
 * tracker's octave-halving errors pile up against its own 70 Hz floor and a low
 * percentile of F0 reports the floor rather than the speaker.
 *
 * @param {Float32Array[]} channelData  one entry per channel
 * @returns {null | { medianF0Hz: number, cornerHz: number,
 *                    voicedFrames: number, totalFrames: number }}
 *   null when there is not enough pitched material to measure from. The caller
 *   must leave whatever it was going to change alone: a voice measurement with
 *   no voice in it has no fallback that means anything.
 */
export function measureVoiceProfile(channelData, sampleRate) {
  if (!channelData?.length || !(sampleRate > 0)) return null

  // Mono mixdown. Pitch is common to both channels, and the tracker takes one.
  const n = channelData[0].length
  if (n === 0) return null
  let mono = channelData[0]
  if (channelData.length > 1) {
    mono = new Float32Array(n)
    for (const ch of channelData) {
      for (let i = 0; i < n; i++) mono[i] += ch[i]
    }
    const scale = 1 / channelData.length
    for (let i = 0; i < n; i++) mono[i] *= scale
  }

  const { f0Values, totalFrames } = collectVoicedFrames(mono, sampleRate)
  if (f0Values.length < MIN_VOICED_FRAMES) return null

  const medianF0Hz = percentile(f0Values, 50)
  const cornerHz = rumbleCornerHz(f0Values)
  if (!(medianF0Hz > 0) || !(cornerHz > 0)) return null

  return { medianF0Hz, cornerHz, voicedFrames: f0Values.length, totalFrames }
}
