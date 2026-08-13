/**
 * Detectors under test, behind one interface.
 *
 * The scorecard's whole purpose is comparison, so what it runs has to be
 * swappable. A detector takes mono audio and a sample rate and returns:
 *
 *   { ok, reason?, bands: [{ freqHz, gainDb, q }], advisories: [...] }
 *
 * `bands` is the correction the user would hear applied — after merging, after
 * capping, after whatever the implementation does internally. Scoring the final
 * corrections rather than the intermediate measurements is deliberate: it is
 * what reaches the audio, and it is the only surface a replacement built on
 * completely different internals can be expected to share.
 */

import { analyzeVoiceRx } from '../../src/audio/voicerx/analysis.js'
import { buildAdvisories } from '../../src/audio/voicerx/suggestions.js'
import { analyzeVoiceRxV2 } from '../../src/audio/voicerx/v2/index.js'

/**
 * The shipping detector: edge-anchored per-region scanning, three correction
 * passes, plus the spectral-hole guard.
 */
export function currentDetector(audio, sampleRate) {
  const analysis = analyzeVoiceRx(audio, sampleRate)
  if (!analysis.ok) return { ok: false, reason: analysis.reason, bands: [], advisories: [] }

  return {
    ok: true,
    bands: analysis.bands.map(b => ({ freqHz: b.freqHz, gainDb: b.gainDb, q: b.q })),
    advisories: buildAdvisories(analysis),
    holes: analysis.holes,
  }
}

/**
 * The replacement: masked by measured SNR, referenced to a robust local trend,
 * features found continuously, corrections scaled by confidence. Not wired into
 * the app — see src/audio/voicerx/v2/index.js.
 */
export function v2Detector(audio, sampleRate) {
  const analysis = analyzeVoiceRxV2(audio, sampleRate)
  if (!analysis.ok) return { ok: false, reason: analysis.reason, bands: [], advisories: [] }

  return {
    ok: true,
    bands: analysis.bands.map(b => ({ freqHz: b.freqHz, gainDb: b.gainDb, q: b.q })),
    advisories: analysis.advisories,
  }
}

/**
 * v1's regions, directions, caps and iteration — with v2's robust local trend
 * in place of the chord baseline, and nothing else changed.
 *
 * The hypothesis this exists to test: the real corpus says the chord is v1's
 * confirmed-bad part (it reads spectral curvature as a hump) and the region
 * table's directional limits are its confirmed-GOOD part (the only thing
 * preventing v2 from cutting the fundamental and boosting into sibilance). If
 * both readings are right, this should beat both parents. One variable.
 */
export function v1TrendDetector(audio, sampleRate) {
  const analysis = analyzeVoiceRx(audio, sampleRate, { baseline: 'trend' })
  if (!analysis.ok) return { ok: false, reason: analysis.reason, bands: [], advisories: [] }

  return {
    ok: true,
    bands: analysis.bands.map(b => ({ freqHz: b.freqHz, gainDb: b.gainDb, q: b.q })),
    advisories: buildAdvisories(analysis),
    holes: analysis.holes,
  }
}

export const DETECTORS = {
  current: currentDetector,
  v1trend: v1TrendDetector,
  v2: v2Detector,
}
