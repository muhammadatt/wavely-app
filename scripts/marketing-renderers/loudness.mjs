import { SR } from './shared.mjs'
import { renderLoudnessNormalize } from '../../src/audio/dsp/loudnessNormalize.js'
import { DEFAULT_TARGET_ID, targetById } from '../../src/audio/loudnessTargets.js'

/**
 * Loudness Normalize: LoudnessWindow.vue's Apply → processing.js
 * loudnessNormalizeRegion → processWorker.js `loudnessNormalize` →
 * dsp/loudnessNormalize.js `renderLoudnessNormalize`, the same function, over
 * the WHOLE region (uncapped, as the worker's measureWholeRegionInWorker is).
 * It measures (LUFS or ACX's ungated RMS + peak), plans the gain and, in LIMIT,
 * solves gain + limiter to the target under the ceiling.
 *
 * Settings: `target` — a benchmark id from loudnessTargets.js (the panel's
 * buttons; default 'podcast'), `peakMode` 'limit' (default) | 'safe'.
 * ⚠ The window keeps its state locally and has no pluginSettings writer, so
 * these keys drive this render only; the editor's "Try it" link cannot dial
 * them in and opens the panel at its own default benchmark.
 */
export default function render(channels, settings) {
  const t = targetById(settings.target ?? DEFAULT_TARGET_ID)
  if (!t) throw new Error(`unknown loudness target: ${settings.target}`)
  const peakMode = settings.peakMode ?? 'limit'
  const target = { targetDb: t.targetDb, unit: t.unit, ceilingDb: t.ceilingDb }
  const { channelData, report } = renderLoudnessNormalize(channels, SR, target, peakMode)
  return {
    channels: channelData,
    note: `${t.label} ${t.targetDb} ${t.unit} / ${t.ceilingDb} ceiling, ${peakMode}: `
      + `${report.measuredDb?.toFixed(2)} → ${report.achievedDb?.toFixed(2)} ${t.unit}, `
      + `peak ${report.achievedPeakDb?.toFixed(2)}, gain ${report.gainDb?.toFixed(2)} dB, limited ${report.limitedDb?.toFixed(2)} dB`,
  }
}
