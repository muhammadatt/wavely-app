/**
 * Adaptive Soft Clipper — real-time effect chain wrapper.
 *
 * The DSP lives in ../softClipperProcessor.js (noise-gated speech-level
 * detector driving an adaptive threshold, RBJ pre/de-emphasis pair, 4x
 * oversampled soft-knee clip curve) and runs in an AudioWorklet. The offline
 * apply path renders through the same worklet in an OfflineAudioContext, so
 * the preview is sample-identical to what gets written to the timeline.
 *
 * The worklet module loads asynchronously; until it's ready the effect
 * passes audio through unprocessed, then splices the worklet node in. Same
 * shape as fet1176Compressor.js / la2aCompressor.js.
 */

import { ensureSoftClipperWorklet } from '../softClipperWorkletLoader.js'
import { SOFT_CLIPPER_LATENCY_SAMPLES, SOFT_CLIPPER_KERNEL_DEFAULTS } from '../softClipperProcessor.js'
import { createLevelTap } from './levelTap.js'
import { recordClipMark, clearClipMarks } from '../clipMarks.js'

export { SOFT_CLIPPER_LATENCY_SAMPLES }

/**
 * How much history the scrolling scope keeps, in seconds.
 *
 * Long enough to see the adaptive threshold actually move — it rides a 3 s
 * tracker, so a window much shorter than this would show it as a flat line and
 * hide the one behaviour that distinguishes adaptive mode from fixed.
 */
export const SCOPE_SECONDS = 4

/**
 * DERIVED from the kernel's own defaults rather than restated here.
 *
 * These were a second literal listing the same five values, which is one
 * careless edit away from the preview and the applied audio running different
 * settings — silently, since every value either object could hold is valid.
 * The kernel is the source of truth; the panel reads this.
 *
 *   headroomDb 4-16, primary control — lower means more clipping
 *   emphasisDb 0-12, HF pre/de-emphasis depth; 0 = bypass both filters
 *   outputTrimDb ±6, post-stage gain match for A/B
 *   thresholdMode 'adaptive' | 'fixed'
 *   fixedThresholdDb, used only in 'fixed' mode
 *   shape 'tanh2' | 'tanh3' | 'tanh4', the knee — see SHAPE_EXPONENT
 */
export const SOFT_CLIPPER_DEFAULTS = { ...SOFT_CLIPPER_KERNEL_DEFAULTS }

/** Params are already kernel-shaped — no renaming needed unlike FET1176/LA2A. */
export function toKernelParams(params) {
  return {
    headroomDb: params.headroomDb,
    emphasisDb: params.emphasisDb,
    outputTrimDb: params.outputTrimDb,
    thresholdMode: params.thresholdMode,
    fixedThresholdDb: params.fixedThresholdDb,
    shape: params.shape,
  }
}

export function createSoftClipper(audioContext) {
  const input = audioContext.createGain()
  // preOutput is a stable internal hand-off — see fet1176Compressor.js for why
  // nothing may hang off `output` directly.
  const preOutput = audioContext.createGain()
  const output = audioContext.createGain()

  let params = { ...SOFT_CLIPPER_DEFAULTS }
  let worklet = null
  let destroyed = false
  let reductionDb = 0

  // Transport origin, for turning the worklet's context-clock stamps into
  // timeline positions. Null when not playing, which is also the signal to
  // stop recording marks: a message can arrive after the transport stopped,
  // and placing that one would put a mark at a position nothing played.
  let transport = null
  let engagedFraction = 0

  // Monitoring mode, kept out of `params` on purpose — see the kernel's
  // setMonitor. It rides its own port message, so the offline render cannot
  // pick it up from a param spread.
  let monitorDelta = false

  // Scope ring. Points arrive batched (see the kernel's SCOPE_BATCH) and are
  // APPENDED rather than replacing a latest-frame, because this display is a
  // scroll rather than a snapshot. Sized from the context's own sample rate so
  // the window is SCOPE_SECONDS wherever it runs.
  const scopeCapacity = Math.ceil((SCOPE_SECONDS * audioContext.sampleRate) / 128)
  const scopePeak = new Float32Array(scopeCapacity)
  const scopeThreshold = new Float32Array(scopeCapacity)
  // Threshold starts above full scale so an unwritten tail reads as "not
  // processing" rather than as a threshold sitting at zero, which would draw
  // every sample as clipped.
  scopeThreshold.fill(1)
  let scopeHead = 0
  let scopeFilled = 0
  // Reused by getScope(), so a 60 Hz reader allocates nothing.
  const scopeView = {
    peak: scopePeak,
    threshold: scopeThreshold,
    capacity: scopeCapacity,
    head: 0,
    filled: 0,
  }

  input.connect(preOutput)
  preOutput.connect(output)

  ensureSoftClipperWorklet(audioContext)
    .then(() => {
      if (destroyed) return
      worklet = new AudioWorkletNode(audioContext, 'soft-clipper-processor', {
        processorOptions: { params: toKernelParams(params) },
      })
      // A monitoring mode set before the module finished loading would
      // otherwise be silently dropped — the node it was meant for did not
      // exist yet.
      if (monitorDelta) worklet.port.postMessage({ type: 'monitor', delta: true })
      worklet.port.onmessage = (e) => {
        if (e.data?.type !== 'gr') return
        reductionDb = e.data.reductionDb
        // Timeline position of the loudest block since the last message. The
        // worklet stamps the block, not the message, so this is good to one
        // render quantum; the ~50 samples of oversampler latency between the
        // clip and the sound leaving the node is another 1.1 ms and is left
        // uncorrected, being well inside the mark grid.
        if (transport && e.data.clipDb > 0) {
          recordClipMark(transport.startSec + (e.data.clipTime - transport.when), e.data.clipDb)
        }
        engagedFraction = e.data.engagedFraction ?? 0
        const batch = e.data.scope
        if (!batch) return
        for (let i = 0; i + 1 < batch.length; i += 2) {
          scopePeak[scopeHead] = batch[i]
          scopeThreshold[scopeHead] = batch[i + 1]
          scopeHead = scopeHead + 1 === scopeCapacity ? 0 : scopeHead + 1
          if (scopeFilled < scopeCapacity) scopeFilled++
        }
      }
      input.disconnect(preOutput)
      input.connect(worklet)
      worklet.connect(preOutput)
    })
    .catch((err) => {
      console.error('Soft Clipper worklet failed to load, running bypassed:', err)
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

    /**
     * Playback started: `when` is the context time it begins sounding and
     * `startSec` the timeline position it begins from. Same contract the
     * clip-gain de-esser's transport hook uses.
     */
    startTransport(when, startSec) {
      transport = { when, startSec }
    },

    stopTransport() {
      transport = null
    },

    setParam(name, value) {
      if (name in params) {
        params[name] = value
        worklet?.port.postMessage({ type: 'params', params: toKernelParams(params) })
        // Every existing mark is a claim about what the OLD setting did. One
        // stale mark next to fresh ones is worse than no marks at all, because
        // nothing distinguishes them on screen.
        clearClipMarks()
      }
    },

    getParam(name) {
      return params[name]
    },

    // Peak reduction, positive dB (peak_in - peak_out) — see GainReductionBar,
    // which takes the magnitude either way.
    getReduction() {
      return reductionDb
    },

    /**
     * Share of voiced blocks the curve engaged on, 0-1.
     *
     * The companion to getReduction, and the one that answers "is this doing
     * anything at all" — of the blocks that clip, the median reduction is
     * 0.3-0.4 dB, which reads as an idle needle on a dB meter.
     */
    getEngagedFraction() {
      return engagedFraction
    },

    /**
     * Audition the residual — only what the stage is removing.
     *
     * A separate call rather than a parameter: parameters are what the apply
     * path renders with, and this must never be one of them.
     */
    setMonitorDelta(on) {
      monitorDelta = !!on
      worklet?.port.postMessage({ type: 'monitor', delta: monitorDelta })
    },

    isMonitoringDelta() {
      return monitorDelta
    },

    /**
     * The scope ring, oldest-to-newest starting at `head` and wrapping.
     *
     * Returns the live arrays rather than a copy — the caller is a canvas
     * redrawing every frame, and copying ~1400 floats 60 times a second to
     * hand back data it only reads would be pure waste. Read it, do not
     * retain it.
     */
    getScope() {
      scopeView.head = scopeHead
      scopeView.filled = scopeFilled
      return scopeView
    },

    getInputLevels(channelCount) {
      return inputTap.getLevels(channelCount)
    },

    getOutputLevels(channelCount) {
      return outputTap.getLevels(channelCount)
    },

    destroy() {
      destroyed = true
      transport = null
      clearClipMarks()
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

export const softClipperEffect = {
  id: 'soft-clipper',
  name: 'Adaptive Soft Clipper',
  latencySamples: SOFT_CLIPPER_LATENCY_SAMPLES,
  createNodes(audioContext) {
    return createSoftClipper(audioContext)
  },
}
