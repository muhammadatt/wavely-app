/**
 * Vocal Saturation — real-time effect chain wrapper.
 *
 * The DSP lives in ../vocalSatProcessor.js (complementary three-band split,
 * knee-order transfer curve with per-band drive, measured-sign asymmetry, and a
 * gain-neutral parallel blend) and runs in an AudioWorklet. The offline apply path renders through
 * the same worklet in an OfflineAudioContext, so the preview is
 * sample-identical to what gets written to the timeline.
 *
 * This replaces a server round-trip: the panel used to POST the rendered
 * selection to /api/spot/vocal_saturation and wait on a modal.
 *
 * The worklet module loads asynchronously; until it's ready the effect passes
 * audio through unprocessed, then splices the worklet node in.
 */

import { ensureVocalSatWorklet } from '../vocalSatWorkletLoader.js'
import {
  VOCAL_SAT_LATENCY_SAMPLES, MODE_SERIES, MODE_PARALLEL,
} from '../vocalSatProcessor.js'
import { createLevelTap } from './levelTap.js'

export { VOCAL_SAT_LATENCY_SAMPLES, MODE_SERIES, MODE_PARALLEL }

/**
 * The two topologies, for the panel's rocker.
 *
 * They are PEERS, not on/off — which is the case DeviceChoiceRocker exists for.
 * Parallel adds a saturated copy under an untouched dry path; series puts the
 * curve in the path. Neither is the absence of the other.
 */
export const VOCAL_SAT_MODES = [
  {
    id: MODE_PARALLEL,
    label: 'PARA',
    title: 'Parallel — the dry signal passes at unity and a saturated copy is added under it',
  },
  {
    id: MODE_SERIES,
    label: 'SERIES',
    title: 'Series — the curve is in the signal path, so it can absorb transients',
  },
]

// Same names and defaults the panel already used, so the UI is unchanged.
export const VOCAL_SAT_DEFAULTS = {
  drive: 2.0,
  wetDry: 1,
  // Was `bias: 1`. Same offset — the reference is 1 and ASYM_MAX_FRACTION is 1,
  // so 100 here is the 1.0 that shipped. Only the sign is now measured.
  asymmetry: 100,
  // ⚠ THE DEFAULT STAYS PARALLEL WITH NO EMPHASIS, which is bit-identical to
  // the build before the switch existed. Series is a different-sounding stage,
  // not a better-sounding one, and every saved patch assumes the old wiring.
  mode: MODE_PARALLEL,
  emphasis: 0,
  // Slew limit ahead of the curve. SERIES ONLY — the kernel ignores it in
  // parallel, where the module that owns it measured the effect's sign
  // REVERSED. The panel disables it there too, so the two agree.
  soften: 0,
  // Was `softness: 0.5`, a crossfade between two curves that measured the same.
  hardness: 2.5,
  lowCrossover: 500,
  midCrossover: 3500,
  lowDriveMult: 8.0,
  midDriveMult: 8,
  highDriveMult: 8,
  // The medium's own bandwidth, 0-100. Moved here from the soft clipper's
  // Drive knob, where a linear shelf sat inside a stage whose identity is
  // transparency. 0 is absent, not flat — see HF_LOSS_CORNER_HZ.
  hfLoss: 0,
}

/** Map UI param names to kernel param names — 1:1 for this effect. */
export function toKernelParams(params) {
  return {
    drive: params.drive,
    wetDry: params.wetDry,
    asymmetry: params.asymmetry,
    mode: params.mode,
    emphasis: params.emphasis,
    soften: params.soften,
    hardness: params.hardness,
    lowCrossover: params.lowCrossover,
    midCrossover: params.midCrossover,
    lowDriveMult: params.lowDriveMult,
    midDriveMult: params.midDriveMult,
    highDriveMult: params.highDriveMult,
    hfLoss: params.hfLoss,
  }
}

export function createVocalSat(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see the note in airBand.js.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...VOCAL_SAT_DEFAULTS }
  let worklet = null
  let destroyed = false

  input.connect(preOutput)
  preOutput.connect(output)

  ensureVocalSatWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'vocal-sat-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Tube Saturation worklet failed to load, running bypassed:', err)
    })

  const inputMonitor = audioContext.createGain()
  input.connect(inputMonitor)
  const outputMonitor = audioContext.createGain()
  preOutput.connect(outputMonitor)

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)

  return {
    input,
    output,

    setParam(name, value) {
      if (name in params) {
        params[name] = value
        worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
      }
    },

    getParam(name) {
      return params[name]
    },

    getInputLevels(channelCount) {
      return inputTap.getLevels(channelCount)
    },

    getOutputLevels(channelCount) {
      return outputTap.getLevels(channelCount)
    },

    destroy() {
      destroyed = true
      input.disconnect()
      worklet?.disconnect()
      preOutput.disconnect()
      output.disconnect()
      inputMonitor.disconnect()
      outputMonitor.disconnect()
      inputTap.destroy()
      outputTap.destroy()
    },
  }
}

export const vocalSatEffect = {
  id: 'vocal-sat',
  name: 'Tube Saturation',
  // The three transfer curves run oversampled, and the halfband filters that
  // get them there are linear phase, so the plugin delays. Constant at every
  // setting — see `latencySamples` on the kernel.
  latencySamples: VOCAL_SAT_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createVocalSat(audioContext)
  },
}
