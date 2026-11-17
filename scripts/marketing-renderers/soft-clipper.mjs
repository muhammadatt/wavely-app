import { SR, renderAligned } from './shared.mjs'
import {
  processSoftClipperBuffer, softClipperLatencySamples, computeSoftClipperAutoMakeupDb,
  SOFT_CLIPPER_MAKEUP_MIN_DB, SOFT_CLIPPER_MAKEUP_MAX_DB,
} from '../../src/audio/softClipperProcessor.js'
import { SOFT_CLIPPER_DEFAULTS, toKernelParams, limiterModeById } from '../../src/audio/effects/softClipperParams.js'
import { DEFAULT_CEILING_PRESET, presetById, measurePeakCeilingDb } from '../../src/audio/ceilingPresets.js'

/**
 * Soft Clipper: useSoftClipper's panel state at opening → apply() →
 * processing.js applySoftClipperRegion (worklet render, per-patch latency
 * trimmed). Mirrored measurements, in the order the panel makes them:
 *   1. the ceiling — the default preset (GENTLE, 97th percentile of block
 *      peaks) via measurePeakCeilingDb, the worker's `softClipperCeiling`;
 *   2. AUTO makeup — computeSoftClipperAutoMakeupDb over the same params
 *      without the trim (the worker's `softClipperAutoMakeup`), clamped to the
 *      Output knob's travel.
 * Both run on measureInWorker's 30 s centred window; the clips are shorter, so
 * that is the whole clip. The panel is fixed-only (`thresholdMode: 'fixed'`)
 * and forwards no emphasisDb on the shipped path.
 *
 * Settings (pluginSettingsExtra softClipperSettings): `peakControl` 'clip' |
 * 'limit', `autoMakeup`, `outputTrimDb` (only while AUTO is off).
 */
export default function render(channels, settings) {
  const mode = limiterModeById(settings.peakControl)
  const params = {
    headroomDb: SOFT_CLIPPER_DEFAULTS.headroomDb,
    outputTrimDb: SOFT_CLIPPER_DEFAULTS.outputTrimDb,
    thresholdMode: 'fixed',
    fixedThresholdDb: SOFT_CLIPPER_DEFAULTS.fixedThresholdDb,
    shape: SOFT_CLIPPER_DEFAULTS.shape,
    limiter: mode ? mode.limiter : SOFT_CLIPPER_DEFAULTS.limiter,
  }
  const ceiling = measurePeakCeilingDb(channels, SR, presetById(DEFAULT_CEILING_PRESET).percentile)
  if (ceiling !== null) params.fixedThresholdDb = ceiling
  const autoMakeup = settings.autoMakeup !== false
  if (autoMakeup) {
    const { outputTrimDb: _ignored, ...rest } = params
    const makeupDb = computeSoftClipperAutoMakeupDb(channels, SR, rest)
    params.outputTrimDb = Math.max(SOFT_CLIPPER_MAKEUP_MIN_DB, Math.min(SOFT_CLIPPER_MAKEUP_MAX_DB, makeupDb))
  } else if (Number.isFinite(settings.outputTrimDb)) {
    params.outputTrimDb = settings.outputTrimDb
  }
  const kp = toKernelParams({ ...SOFT_CLIPPER_DEFAULTS, ...params })
  const latency = softClipperLatencySamples(kp, SR)
  const out = renderAligned(channels, latency, ch => processSoftClipperBuffer(ch, SR, kp).channelData)
  return {
    channels: out,
    note: `${mode?.id ?? (kp.limiter > 0 ? 'limit' : 'clip')}, ceiling ${params.fixedThresholdDb.toFixed(2)} dBFS, makeup ${params.outputTrimDb.toFixed(2)} dB, latency ${latency}`,
  }
}
