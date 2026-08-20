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
 * Drop one edge of the graph, tolerating an edge that has already gone.
 *
 * `AudioNode.disconnect(target)` throws InvalidAccessError when there is no
 * such connection, and there often is not by the time a tap is destroyed: every
 * effect wrapper calls a wholesale `monitor.disconnect()` before tearing its
 * taps down, which has already removed this edge. Throwing there would abort
 * the rest of the teardown — the thing the disconnect exists to make thorough.
 */
function dropEdge(from, to) {
  try {
    from.disconnect(to)
  } catch {
    // Already disconnected upstream; nothing to do.
  }
}

/**
 * Frequency-domain tap — the EQ's backdrop trace and the standalone analyzer.
 *
 * Sized larger than the level tap and with lighter smoothing: this one is read
 * as a curve across frequency rather than as a single number, so resolution
 * matters and inter-frame averaging mostly costs responsiveness. The 4096-point
 * default gives ~10 Hz bins at 44.1 kHz — enough to see a room mode, not so
 * many points that drawing it competes with the audio thread.
 *
 * Resolution and smoothing are settable because the standalone analyzer offers
 * them as controls; every effect window takes the defaults, which are the
 * values this tap shipped with.
 */
export function createSpectrumTap(audioContext, node, {
  fftSize = 4096,
  smoothing = 0.5,
  minDecibels = -110,
  maxDecibels = -10,
} = {}) {
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = fftSize
  analyser.smoothingTimeConstant = smoothing
  analyser.minDecibels = minDecibels
  analyser.maxDecibels = maxDecibels
  node.connect(analyser)

  const silentSink = audioContext.createGain()
  silentSink.gain.value = 0
  analyser.connect(silentSink)
  silentSink.connect(audioContext.destination)

  let bins = new Float32Array(analyser.frequencyBinCount)

  return {
    analyser,
    // Getters, not values: resolution is adjustable on the standalone analyzer,
    // and a consumer that read the bin width once would keep drawing a frame
    // whose x axis is off by a factor of two after the first size change.
    get binCount() { return analyser.frequencyBinCount },
    /** Hz per bin, for mapping bins onto a log frequency axis. */
    get binWidthHz() { return audioContext.sampleRate / analyser.fftSize },
    /**
     * Resolution, in FFT points. Larger sees a hum harmonic apart from its
     * neighbour; smaller follows a transient. Reallocates the read buffer,
     * because frequencyBinCount moves with it.
     */
    setFftSize(size) {
      if (analyser.fftSize === size) return
      analyser.fftSize = size
      bins = new Float32Array(analyser.frequencyBinCount)
    },
    /** Inter-frame averaging, 0..1. Smooths the trace, costs responsiveness. */
    setSmoothing(value) {
      analyser.smoothingTimeConstant = Math.max(0, Math.min(0.95, value))
    },
    /** Magnitudes in dBFS, reusing one array — do not retain it. */
    getSpectrumDb() {
      analyser.getFloatFrequencyData(bins)
      return bins
    },
    destroy() {
      // The source side too. `analyser.disconnect()` drops only what the
      // analyser feeds — the `node -> analyser` edge made above is the source's
      // connection, and it survives. A window opened and closed repeatedly
      // would leave the node feeding a row of orphaned analysers, each still
      // pulled for every quantum of every playback.
      dropEdge(node, analyser)
      analyser.disconnect()
      silentSink.disconnect()
    },
  }
}

/** Channels the tap is wired to measure. Voice work does not exceed stereo. */
export const MAX_METER_CHANNELS = 2

/**
 * Copy a reading out of the tap's reused object.
 *
 * `getLevels` hands back the same object every frame, which is right for a
 * 60 Hz read and wrong for anything that stores it: assigning it to a ref
 * would leave every past reading pointing at the present one.
 */
export function snapshotLevels(levels) {
  const out = []
  for (let ch = 0; ch < levels.count; ch++) {
    out.push({ rmsDb: levels.channels[ch].rmsDb, peakDb: levels.channels[ch].peakDb })
  }
  return out
}

/**
 * Time-domain tap, for the level meters. Measures each channel separately.
 *
 * A splitter feeds one analyser per channel, because an analyser placed
 * straight on the signal reports its mono downmix — on which a peak in one
 * channel of a stereo pair reads low, and a channel imbalance does not appear
 * at all. Splitting is what makes a stereo meter mean anything.
 *
 * The splitter's `channelInterpretation` is "discrete", so a mono source
 * lights channel 0 and leaves channel 1 digitally silent rather than
 * duplicating into it. Callers must therefore ask for the number of channels
 * the source actually has — request two for a mono file and the second bar
 * reads a convincing, permanent -∞.
 *
 * No `smoothingTimeConstant` here: it only applies to the FFT that backs
 * `getFloatFrequencyData`, so on a tap that is read purely in the time domain
 * it does nothing. Meter ballistics belong to whoever renders the reading.
 */
export function createLevelTap(audioContext, node) {
  const splitter = audioContext.createChannelSplitter(MAX_METER_CHANNELS)
  node.connect(splitter)

  const silentSink = audioContext.createGain()
  silentSink.gain.value = 0
  silentSink.connect(audioContext.destination)

  const analysers = []
  const buffers = []
  for (let ch = 0; ch < MAX_METER_CHANNELS; ch++) {
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 1024
    splitter.connect(analyser, ch)
    analyser.connect(silentSink)
    analysers.push(analyser)
    buffers.push(new Float32Array(analyser.fftSize))
  }

  // Reused across frames, one entry per channel.
  const channels = analysers.map(() => ({ rmsDb: -Infinity, peakDb: -Infinity }))
  const levels = { count: 0, channels }

  return {
    analysers,
    /**
     * Per-channel RMS and sample peak of the most recent window, in dBFS.
     *
     * `count` is how many channels the source really carries; only that many
     * entries are refreshed, and `levels.count` reports how many are valid.
     *
     * The window is 1024 samples and a 60 Hz caller advances 735 of them
     * between reads, so consecutive windows overlap and no sample goes
     * unseen. That is what makes the peak reading trustworthy enough to
     * drive an over indicator — the guarantee does not survive rAF
     * throttling in a backgrounded tab, where samples can pass unread.
     *
     * Reuses one object — read the fields, do not retain it.
     */
    getLevels(count = MAX_METER_CHANNELS) {
      const active = Math.max(1, Math.min(MAX_METER_CHANNELS, count))
      levels.count = active
      for (let ch = 0; ch < active; ch++) {
        const data = buffers[ch]
        analysers[ch].getFloatTimeDomainData(data)
        let sumSquares = 0
        let peak = 0
        for (let i = 0; i < data.length; i++) {
          const sample = data[i]
          sumSquares += sample * sample
          const magnitude = Math.abs(sample)
          if (magnitude > peak) peak = magnitude
        }
        const rms = Math.sqrt(sumSquares / data.length)
        channels[ch].rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity
        channels[ch].peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity
      }
      return levels
    },
    destroy() {
      // Same source-side edge as the spectrum tap: dropping the splitter's own
      // outgoing connections leaves `node -> splitter` in place.
      dropEdge(node, splitter)
      splitter.disconnect()
      for (const analyser of analysers) analyser.disconnect()
      silentSink.disconnect()
    },
  }
}
