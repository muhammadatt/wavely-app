import { SR, peakDb, renderAligned } from './shared.mjs'
import { regionAlignDb, regionPeakDb } from '../../src/audio/analysisWindow.js'
import { ALIGN_TARGET_DBFS } from '../../src/audio/dsp/inputAlign.js'
import { measureBandSpectrum, bandRefPeakDb } from '../../src/audio/saturationBenchAnalysis.js'
import { PHATASS_DEFAULTS, WARMTH_LAYERS, toKernelParams, phatassLatencySamples } from '../../src/audio/phatassParams.js'
import { measureTapeMakeup } from '../../src/audio/phatassTapeMakeup.js'
import { measureOutputMakeup } from '../../src/audio/phatassOutputMakeup.js'
import { processPhatassBuffer } from '../../src/audio/phatassProcessor.js'

/** The clip as a one-segment timeline, so the measurements read it the way they read a document. */
function wholeClip(channels) {
  const dur = channels[0].length / SR
  const sourceBuffer = { numberOfChannels: channels.length, length: channels[0].length, getChannelData: ch => channels[ch] }
  return { segments: [{ sourceBuffer, sourceStart: 0, sourceEnd: dur, outputStart: 0 }], dur }
}

/**
 * usePhatass.prepareApply (refreshLevel: voice level + Warmth's band references
 * over the whole file; refreshCeiling: the selection's peak; the EXACT TAPE
 * makeup; the output trim when it is on) → applyPhatassRegion. Whole clip in
 * one pass (the parallel-chunk path is bit-identical by design); the 1 s
 * pre-roll reads nothing before the clip's start, so it is silence, as here.
 */
export default function render(channels, settings) {
  const { segments, dur } = wholeClip(channels)
  const nCh = channels.length
  const p = { ...PHATASS_DEFAULTS, ...settings }
  // refreshLevel
  p.voiceLevelDb = ALIGN_TARGET_DBFS - regionAlignDb(segments, 0, dur, SR, nCh)
  const spectrum = measureBandSpectrum(segments, 0, dur, SR, nCh)
  p.warmthRefPeaksDb = WARMTH_LAYERS.map(l => bandRefPeakDb(spectrum, l.loHz, l.hiHz))
  // refreshCeiling
  const ceil = regionPeakDb(segments, 0, dur, SR, nCh)
  p.warmthCeilingDb = Number.isFinite(ceil) ? ceil : null
  // TAPE's exact makeup (the worker's measureTapeMakeup, exact path)
  p.tapeMakeupDb = Number(p.tape) > 0 ? measureTapeMakeup(channels, SR, p, { exact: true }).makeupDb : 0
  // The bench's output trim, rendered with TAPE's makeup in place
  if (p.outputMakeup === 'peak' || p.outputMakeup === 'rms') {
    p.outputMakeupDb = measureOutputMakeup(channels, SR, p, { exact: true }).makeupDb
  }
  const kp = toKernelParams(p)
  const out = renderAligned(channels, phatassLatencySamples(SR), ch => processPhatassBuffer(ch, SR, kp).channelData)
  return {
    channels: out,
    note: `voice ${p.voiceLevelDb.toFixed(1)} dBFS, ceiling ${(p.warmthCeilingDb ?? NaN).toFixed(2)} dB, tape makeup ${p.tapeMakeupDb.toFixed(2)} dB, out peak ${peakDb(out).toFixed(2)}`,
  }
}
