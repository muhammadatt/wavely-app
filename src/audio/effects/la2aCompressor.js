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

    destroy() {
      input.disconnect()
      compressor.disconnect()
      makeupGain.disconnect()
      output.disconnect()
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
