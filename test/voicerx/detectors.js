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

export const DETECTORS = {
  current: currentDetector,
}
