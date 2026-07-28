/**
 * RMS level meter tap, shared by the real-time effect wrappers.
 *
 * An AnalyserNode only gets pulled for processing if it's part of a graph
 * that's reachable from the destination — a tap with no downstream connection
 * can silently stop updating. Route it through a silent sink so it's always
 * actively processed regardless of engine optimizations.
 */
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
