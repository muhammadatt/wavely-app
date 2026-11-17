import { SR } from './shared.mjs'
import { ALIGN_TARGET_DBFS, inputAlignDbFor } from '../../src/audio/dsp/inputAlign.js'
import { AUTO_MAKEUP_MAX_ANALYSIS_S } from '../../src/audio/analysisWindow.js'
import { levelOffsetDbFor } from '../../src/audio/deEsserProcessor.js'
import { measureTopLossDb, autoAirDb } from '../../src/audio/deEsserAutoAir.js'
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES } from '../../src/audio/deEsserResoStage.js'
import { softenLatencySamples } from '../../src/audio/deEsserSoftenStage.js'
import { renderChunk } from '../../src/audio/chunkRender.js'
import {
  DE_ESSER_DEFAULTS, toKernelParams, resoOn, resoKernelParams, softenOn, softenStageKernelParams,
} from '../../src/audio/deEsserParams.js'

/**
 * useDeEsser.prepareApply → applyDeEsserPluginRegion (src/audio/processing.js).
 *
 * prepareApply: refreshLevel — the WHOLE file's gated RMS (regionAlignDb, here
 * inputAlignDbFor on the same clip) → levelOffsetDbFor → `levelOffset`; then,
 * with AUTO (`comp`) on, refreshAutoAir — the worker's deEsserAutoAir op
 * (measureTopLossDb → autoAirDb) over the capped analysis window with the
 * current params — which writes `air`.
 *
 * The render is the worklet graph applyWorkletRegion builds: the De-Esser
 * kernel, then the Reso post-stage (resoAmount > 0, off the panel) and the
 * Soften post-stage on the HF Limiter kernel (soften > 0), each stage on the
 * previous one's stream, the chain's summed latency rendered long and trimmed.
 * renderChunk is that chain (the same kernels the worklets run). No pre-roll:
 * a selection starting at t = 0 gets none (regionPreRoll clamps to the timeline).
 */
export default function render(channels, settings) {
  const n = channels[0].length
  const panel = { ...DE_ESSER_DEFAULTS, ...settings }
  // useDeEsser.currentParams pins these off the panel.
  for (const k of ['context', 'rotator', 'release', 'vowelRelease', 'shape', 'airMode']) panel[k] = DE_ESSER_DEFAULTS[k]

  const gated = ALIGN_TARGET_DBFS - inputAlignDbFor(channels, SR)
  panel.levelOffset = levelOffsetDbFor(gated)

  let lossDb = null
  if (panel.comp) {
    const win = Math.min(n, Math.ceil(AUTO_MAKEUP_MAX_ANALYSIS_S * SR))
    const windowed = channels.map(c => c.slice(0, win))
    lossDb = measureTopLossDb(
      windowed, SR, toKernelParams(panel),
      resoOn(panel) ? resoKernelParams(panel) : null, HF_RESO_FRAME_SIZE,
    )
    panel.air = autoAirDb(lossDb)
  }

  const stages = [
    { renderer: 'deEsser', kernelParams: toKernelParams(panel) },
    ...(resoOn(panel) ? [{ renderer: 'resonance', kernelParams: resoKernelParams(panel), options: { frameSize: HF_RESO_FRAME_SIZE } }] : []),
    ...(softenOn(panel) ? [{ renderer: 'hfLimiter', kernelParams: softenStageKernelParams(panel) }] : []),
  ]
  const latency = (resoOn(panel) ? HF_RESO_LATENCY_SAMPLES : 0) + (softenOn(panel) ? softenLatencySamples(SR) : 0)
  const padded = channels.map((c) => { const q = new Float32Array(n + latency); q.set(c); return q })
  const out = renderChunk(padded, SR, { stages, latency, skip: 0, length: n })
  const air = lossDb === null ? `air ${panel.air} dB` : `top loss ${lossDb.toFixed(2)} dB → auto air ${panel.air} dB`
  return { channels: out, note: `level offset ${panel.levelOffset.toFixed(2)} dB, ${air}${softenOn(panel) ? `, soften ${panel.soften}` : ''}` }
}
