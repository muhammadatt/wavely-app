/**
 * LA-2A-style optical compressor using Web Audio API nodes.
 *
 * The real LA-2A is an electro-optical leveling amplifier with two controls:
 *   - Peak Reduction: how much compression is applied (maps to threshold)
 *   - Gain: makeup gain after compression
 *
 * Optical compressors have program-dependent behavior — the photocell's
 * response gives a fast attack with a slow, two-stage release. The
 * DynamicsCompressorNode approximates this with a soft knee, moderate ratio,
 * and slow release.
 */

export const LA2A_DEFAULTS = {
  peakReduction: 50,
  gain: 0,
}

function createLevelTap(audioContext, node) {
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6
  node.connect(analyser)

  // An AnalyserNode only gets pulled for processing if it's part of a graph
  // that's reachable from the destination — a tap with no downstream
  // connection can silently stop updating. Route it through a silent sink
  // so it's always actively processed regardless of engine optimizations.
  const silentSink = audioContext.createGain()
  silentSink.gain.value = 0
  analyser.connect(silentSink)
  silentSink.connect(audioContext.destination)

  const data = new Float32Array(analyser.fftSize)

  return {
    analyser,
    getLevelDb() {
      analyser.getFloatTimeDomainData(data)
      let sumSquares = 0
      for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i]
      const rms = Math.sqrt(sumSquares / data.length)
      if (rms <= 0) return -Infinity
      return 20 * Math.log10(rms)
    },
    destroy() {
      analyser.disconnect()
      silentSink.disconnect()
    },
  }
}

export function createLA2ACompressor(audioContext) {
  const input = audioContext.createGain()
  const output = audioContext.createGain()

  const compressor = audioContext.createDynamicsCompressor()
  const makeupGain = audioContext.createGain()

  let params = { ...LA2A_DEFAULTS }

  function applyParams() {
    const threshold = -10 - (params.peakReduction / 100) * 40
    const ratio = 4 + (params.peakReduction / 100) * 8
    const knee = 20 - (params.peakReduction / 100) * 10

    const t = audioContext.currentTime
    compressor.threshold.setValueAtTime(threshold, t)
    compressor.ratio.setValueAtTime(ratio, t)
    compressor.knee.setValueAtTime(knee, t)
    compressor.attack.setValueAtTime(0.01, t)
    compressor.release.setValueAtTime(0.3 + (params.peakReduction / 100) * 0.7, t)

    const gainLinear = Math.pow(10, params.gain / 20)
    makeupGain.gain.setValueAtTime(gainLinear, t)
  }

  input.connect(compressor)
  compressor.connect(makeupGain)
  makeupGain.connect(output)

  applyParams()

  // Tap level meters off dedicated monitor nodes fed in parallel from the
  // signal path, rather than off `input`/`output` directly. The chain
  // legitimately calls `.disconnect()` on an effect's `output` node on every
  // rebuild (to re-route it to whatever comes next), which would also wipe a
  // tap connected straight to `output`.
  const inputMonitor = audioContext.createGain()
  input.connect(inputMonitor)
  const outputMonitor = audioContext.createGain()
  makeupGain.connect(outputMonitor)

  const inputTap = createLevelTap(audioContext, inputMonitor)
  const outputTap = createLevelTap(audioContext, outputMonitor)

  return {
    input,
    output,

    setParam(name, value) {
      if (name in params) {
        params[name] = value
        applyParams()
      }
    },

    getParam(name) {
      return params[name]
    },

    getReduction() {
      return compressor.reduction
    },

    getInputLevelDb() {
      return inputTap.getLevelDb()
    },

    getOutputLevelDb() {
      return outputTap.getLevelDb()
    },

    destroy() {
      input.disconnect()
      compressor.disconnect()
      makeupGain.disconnect()
      output.disconnect()
      inputMonitor.disconnect()
      outputMonitor.disconnect()
      inputTap.destroy()
      outputTap.destroy()
    },
  }
}

export const la2aEffect = {
  id: 'la2a-compressor',
  name: 'LA-2A Compressor',
  createNodes(audioContext) {
    return createLA2ACompressor(audioContext)
  },
}
