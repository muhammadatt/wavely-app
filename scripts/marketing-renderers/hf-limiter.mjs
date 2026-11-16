import { SR, renderAligned } from './shared.mjs'
import { ALIGN_TARGET_DBFS, inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import { processHFLimiterBuffer } from '../../src/audio/hfLimiterProcessor.js'
import { HF_LIMITER_DEFAULTS, hfLimiterLatencySamples, toKernelParams } from '../../src/audio/hfLimiterParams.js'

/**
 * useHFLimiter.prepareApply → applyHFLimiterRegion (src/audio/processing.js).
 *
 * prepareApply: refreshLevel — the WHOLE file's gated RMS (regionAlignDb, here
 * inputAlignDbFor on the same clip) → `voiceLevelDb`, which the Threshold is
 * relative to. Then the kernel with its constant latency rendered long and
 * trimmed. No pre-roll: a selection starting at t = 0 gets none.
 */
export default function render(channels, settings) {
  const voiceLevelDb = ALIGN_TARGET_DBFS - inputAlignDbFor(channels, SR)
  const kp = toKernelParams({ ...HF_LIMITER_DEFAULTS, ...settings, voiceLevelDb })
  const latency = hfLimiterLatencySamples(SR)
  const out = renderAligned(channels, latency, ch => processHFLimiterBuffer(ch, SR, kp).channelData)
  return { channels: out, note: `voice level ${voiceLevelDb.toFixed(2)} dBFS, threshold ${kp.thresholdDb.toFixed(2)} dBFS` }
}
