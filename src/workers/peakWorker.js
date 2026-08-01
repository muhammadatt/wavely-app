/**
 * Peak Cache Web Worker
 *
 * Receives channel data and computes min/max peaks per pixel column, for every
 * channel independently — a stereo file draws as two lanes, so summing to mono
 * here would throw away what the display needs.
 *
 * Message format:
 *   { channelData: Float32Array[], samplesPerPx: number, totalSamples: number }
 * Response:
 *   { peaks: Float32Array[] } — one entry per channel, each interleaved
 *   [min0, max0, min1, max1, ...]
 */
self.onmessage = function (e) {
  const { channelData, samplesPerPx, totalSamples } = e.data

  const numPeaks = Math.ceil(totalSamples / samplesPerPx)
  const peaks = []

  for (let ch = 0; ch < channelData.length; ch++) {
    const data = channelData[ch]
    const chPeaks = new Float32Array(numPeaks * 2)

    for (let i = 0; i < numPeaks; i++) {
      const start = Math.floor(i * samplesPerPx)
      const end = Math.min(Math.floor((i + 1) * samplesPerPx), totalSamples)

      let min = 1.0
      let max = -1.0

      for (let j = start; j < end; j++) {
        const val = data[j]
        if (val < min) min = val
        if (val > max) max = val
      }

      chPeaks[i * 2] = min
      chPeaks[i * 2 + 1] = max

      // Progress update every 10000 peaks, weighted across channels so the
      // fraction still runs 0→1 for a stereo file rather than 0→1 twice.
      if (i % 10000 === 0) {
        self.postMessage({
          type: 'progress',
          progress: (ch + i / numPeaks) / channelData.length,
        })
      }
    }

    peaks.push(chPeaks)
  }

  self.postMessage({ type: 'done', peaks }, peaks.map(p => p.buffer))
}
