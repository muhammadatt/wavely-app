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

/**
 * Time-domain tap, for the level meters.
 *
 * No `smoothingTimeConstant` here: it only applies to the FFT that backs
 * `getFloatFrequencyData`, so on a tap that is read purely in the time domain
 * it does nothing. Meter ballistics belong to whoever renders the reading.
 */
export function createLevelTap(audioContext, node) {
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  node.connect(analyser)

  const silentSink = audioContext.createGain()
  silentSink.gain.value = 0
  analyser.connect(silentSink)
  silentSink.connect(audioContext.destination)

  const data = new Float32Array(analyser.fftSize)
  const levels = { rmsDb: -Infinity, peakDb: -Infinity }

  return {
    analyser,
    /**
     * RMS and sample peak of the most recent window, both in dBFS.
     *
     * The window is 1024 samples and a 60 Hz caller advances 735 of them
     * between reads, so consecutive windows overlap and no sample goes
     * unseen. That is what makes the peak reading trustworthy enough to
     * drive an over indicator — the guarantee does not survive rAF
     * throttling in a backgrounded tab, where samples can pass unread.
     *
     * Both figures are taken from the analyser's mono downmix, so a peak on
     * one channel of a stereo file reads lower here than it truly is.
     *
     * Reuses one object — read the fields, do not retain it.
     */
    getLevels() {
      analyser.getFloatTimeDomainData(data)
      let sumSquares = 0
      let peak = 0
      for (let i = 0; i < data.length; i++) {
        const sample = data[i]
        sumSquares += sample * sample
        const magnitude = Math.abs(sample)
        if (magnitude > peak) peak = magnitude
      }
      const rms = Math.sqrt(sumSquares / data.length)
      levels.rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity
      levels.peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity
      return levels
    },
    destroy() {
      analyser.disconnect()
      silentSink.disconnect()
    },
  }
}
