/**
 * Saturation Bench — the AudioWorklet registration. The DSP (layers, voicing
 * detector, kernel, offline render) lives in dsp/saturationLayers.js so other
 * worklets can run it without registering this processor a second time in the
 * same AudioWorkletGlobalScope, which throws.
 */

import { SaturationBenchKernel } from './dsp/saturationLayers.js'

export * from './dsp/saturationLayers.js'

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class SaturationBenchWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new SaturationBenchKernel(sampleRate)
      if (options?.processorOptions?.params) this.kernel.setParams(options.processorOptions.params, true)
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        else if (e.data?.type === 'listen') this.kernel.setListen(e.data.mode)
      }
    }

    process(inputs, outputs) {
      const input = inputs[0]
      const output = outputs[0]
      if (!output || output.length === 0) return true
      const n = output[0].length
      if (!input || input.length === 0) {
        for (const ch of output) ch.fill(0)
        return true
      }
      this.kernel.process(input, output, n)
      return true
    }
  }

  registerProcessor('saturation-bench-processor', SaturationBenchWorkletProcessor)
}
