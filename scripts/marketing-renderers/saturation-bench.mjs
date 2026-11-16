import { SR, renderAligned } from './shared.mjs'
import { measureBandSpectrum, bandRefPeakDb, voicingOffsetDb } from '../../src/audio/saturationBenchAnalysis.js'
import { SATURATION_BENCH_DEFAULTS, toKernelParams } from '../../src/audio/saturationBenchParams.js'
import { SAT_BENCH_LATENCY_SAMPLES, processSaturationBenchBuffer } from '../../src/audio/dsp/saturationLayers.js'

/**
 * useSaturationBench.prepareApply (refreshSpectrum: ONE gated long-term
 * spectrum of the whole file, giving each layer's reference peak and the
 * voicing offset — currentParams) → applySaturationBenchRegion. Whole clip in
 * one pass (the parallel-chunk path is bit-identical by design); the pre-roll
 * reads nothing before the clip's start, so it is silence, as here.
 */
export default function render(channels, settings) {
  const dur = channels[0].length / SR
  const sourceBuffer = { numberOfChannels: channels.length, length: channels[0].length, getChannelData: ch => channels[ch] }
  const segments = [{ sourceBuffer, sourceStart: 0, sourceEnd: dur, outputStart: 0 }]
  const spectrum = measureBandSpectrum(segments, 0, dur, SR, channels.length)
  const panel = { ...SATURATION_BENCH_DEFAULTS, ...settings }
  const layers = panel.layers.map(l => ({ ...l }))
  const params = {
    layers,
    refPeaks: layers.map(l => bandRefPeakDb(spectrum, l.loHz, l.hiHz)),
    levelOffset: voicingOffsetDb(spectrum),
    inputDb: panel.inputDb,
    outputDb: panel.outputDb,
  }
  const kp = toKernelParams(params)
  const out = renderAligned(channels, SAT_BENCH_LATENCY_SAMPLES, ch => processSaturationBenchBuffer(ch, SR, kp).channelData)
  const used = layers.filter(l => l.on)
  return {
    channels: out,
    note: `gated ${spectrum ? spectrum.gatedRmsDb.toFixed(1) : '—'} dBFS, ${used.length} layers, ref peaks ${params.refPeaks.slice(0, used.length).map(v => v.toFixed(1)).join(' / ')} dBFS`,
  }
}
