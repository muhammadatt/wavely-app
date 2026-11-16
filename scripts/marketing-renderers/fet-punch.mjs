import { SR, peakDb, renderAligned } from './shared.mjs'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import { restorePeakToCeiling } from '../../src/audio/dsp/makeupReference.js'
import {
  computeFET1176AutoMakeupPlan, processFET1176Buffer, FET1176_OUTPUT_MIN_DB, FET1176_OUTPUT_MAX_DB,
} from '../../src/audio/fet1176Processor.js'
import { fet1176TuningState } from '../../src/audio/effects/fet1176Tuning.js'
import {
  FET1176_DEFAULTS, fetDriveFor, toKernelParams as fetKernelParams,
} from '../../src/audio/effects/fet1176Params.js'

/**
 * useFET1176.prepareApply (refreshInputAlign → refreshAutoMakeup: the whole
 * file's alignment, then the percentile makeup solve with the ceiling at the
 * region's own peak) → processing.js applyFET1176Region (the kernel render,
 * latency trimmed, then restorePeakToCeiling on the whole rendered region).
 *
 * The worker's makeup solve sees a capped 30 s window; every clip here is
 * shorter, so it sees the whole region, and the solved knee is kept (the
 * `analysedWholeRegion` case). Alignment uses `inputAlignDbFor` on the
 * materialised clip, the same gated statistic `regionAlignDb` computes over
 * the timeline.
 */
export default function render(channels, settings) {
  const panel = { ...FET1176_DEFAULTS, ...settings }
  const inputAlignDb = inputAlignDbFor(channels, SR)
  // measurementParams(): kernel params with the Output being solved for.
  const plan = computeFET1176AutoMakeupPlan(channels, SR, {
    ...fet1176TuningState(),
    inputDrive: panel.inputDrive,
    outputGainDb: 0,
    attack: panel.attack,
    release: panel.release,
    ratio: panel.ratio,
    fetDrive: fetDriveFor(panel),
    scHpfHz: panel.scHpf,
    mix: panel.mix,
    inputAlignDb,
  }, { reference: 'percentile', minDb: FET1176_OUTPUT_MIN_DB, maxDb: FET1176_OUTPUT_MAX_DB })
  const ceilingDb = peakDb(channels)
  const kp = fetKernelParams({
    ...panel,
    output: Math.max(FET1176_OUTPUT_MIN_DB, Math.min(FET1176_OUTPUT_MAX_DB, plan.makeupDb)),
    inputAlignDb,
    ceilingDb,
    ceilingKneeDb: plan.ceilingKneeDb,
  })
  const probe = processFET1176Buffer([new Float32Array(128)], SR, kp)
  const out = renderAligned(channels, probe.latencySamples, ch => processFET1176Buffer(ch, SR, kp).channelData)
  const trimDb = restorePeakToCeiling(out, kp.ceilingDb)
  return {
    channels: out,
    note: `align ${inputAlignDb.toFixed(2)} dB, makeup ${plan.makeupDb.toFixed(2)} dB, peak restore ${trimDb.toFixed(2)} dB`,
  }
}
