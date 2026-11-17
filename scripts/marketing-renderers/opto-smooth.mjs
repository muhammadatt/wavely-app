import { SR, peakDb, renderAligned } from './shared.mjs'
import { inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import { computeAutoMakeupPlan, processLA2ABuffer } from '../../src/audio/la2aProcessor.js'
import { LA2A_DEFAULTS, toKernelParams as la2aKernelParams } from '../../src/audio/effects/la2aParams.js'

/** useLA2A.prepareApply (alignment, then the percentile makeup solve) → applyLA2ARegion. */
export default function render(channels, settings) {
  const panel = { ...LA2A_DEFAULTS, ...settings }
  const inputAlignDb = inputAlignDbFor(channels, SR)
  const plan = computeAutoMakeupPlan(channels, SR, {
    mode: panel.mode, peakReduction: panel.peakReduction, gainDb: 0, r37: panel.r37,
    lookaheadMs: panel.lookahead, analog: panel.analog !== false, mix: panel.mix, inputAlignDb,
  }, { reference: 'percentile' })
  const kp = la2aKernelParams({
    ...panel,
    gain: Math.max(-24, Math.min(24, plan.makeupDb)),
    ceilingDb: peakDb(channels),
    ceilingKneeDb: plan.ceilingKneeDb,
    inputAlignDb,
  })
  const probe = processLA2ABuffer([new Float32Array(128)], SR, kp)
  const out = renderAligned(channels, probe.latencySamples, ch => processLA2ABuffer(ch, SR, kp).channelData)
  return { channels: out, note: `align ${inputAlignDb.toFixed(2)} dB, makeup ${plan.makeupDb.toFixed(2)} dB` }
}
