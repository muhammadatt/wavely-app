/**
 * Analyser taps, shared by the real-time effect wrappers.
 *
 * An AnalyserNode only gets pulled for processing if it's part of a graph
 * that's reachable from the destination — a tap with no downstream connection
 * can silently stop updating. Route it through a silent sink so it's always
 * actively processed regardless of engine optimizations.
 *
 * That routing requirement is the reason both taps live here rather than with
 * their consumers: it is the part that is easy to omit and produces a meter
 * that works until the day some unrelated graph change makes it stop.
 */

/**
 * Frequency-domain tap, for the manual EQ's spectrum analyzer.
 *
 * Sized larger than the level tap and with lighter smoothing: this one is read
 * as a curve across frequency rather than as a single number, so resolution
 * matters and inter-frame averaging mostly costs responsiveness. 4096 gives
 * ~10 Hz bins at 44.1 kHz — enough to see a room mode, not so many points that
 * drawing it competes with the audio thread.
 */
export function createSpectrumTap(audioContext, node) {
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 4096
  analyser.smoothingTimeConstant = 0.5
  analyser.minDecibels = -110
  analyser.maxDecibels = -10
  node.connect(analyser)

  const silentSink = audioContext.createGain()
  silentSink.gain.value = 0
  analyser.connect(silentSink)
  silentSink.connect(audioContext.destination)

  const bins = new Float32Array(analyser.frequencyBinCount)

  return {
    analyser,
    binCount: analyser.frequencyBinCount,
    /** Hz per bin, for mapping bins onto a log frequency axis. */
    binWidthHz: audioContext.sampleRate / analyser.fftSize,
    /** Magnitudes in dBFS, reusing one array — do not retain it. */
    getSpectrumDb() {
      analyser.getFloatFrequencyData(bins)
      return bins
    },
    destroy() {
      analyser.disconnect()
      silentSink.disconnect()
    },
  }
}

export function createLevelTap(audioContext, node) {
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.6
  node.connect(analyser)

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
