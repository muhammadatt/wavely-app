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
 * The shipping detector, whatever it currently is — called with no options on
 * purpose, so this tracks the default rather than restating it.
 *
 * It is presently identical to `v1trend` except for the baseline: per-region
 * scanning against an edge-anchored chord, two correction passes, the
 * bandwidth-edge slope guard and the spectral-hole guard.
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
 * The robust-local-trend baseline — everything else identical to `current`.
 *
 * Not the shipping detector, and not a dead end either: it beats the chord on
 * every countable measure taken against finished masters, and loses on the one
 * measure only a person can take. Kept wired and scored so that the two open
 * problems standing between it and shipping — the low-frequency blind spot and
 * the band merge — can be worked on against numbers.
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
