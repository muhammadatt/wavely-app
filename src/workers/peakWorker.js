/**
 * Peak Cache Web Worker
 *
 * Receives channel data and computes min/max peaks per pixel column.
 * Message format:
 *   { channelData: Float32Array[], samplesPerPx: number, totalSamples: number }
 * Response:
 *   { peaks: Float32Array (interleaved [min0, max0, min1, max1, ...]) }
 */
self.onmessage = function (e) {
  const { channelData, samplesPerPx, totalSamples } = e.data

  // Use first channel for peak calculation (mono display)
  const data = channelData[0]
  const numPeaks = Math.ceil(totalSamples / samplesPerPx)
  const peaks = new Float32Array(numPeaks * 2)

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

    peaks[i * 2] = min
    peaks[i * 2 + 1] = max

    // Progress update every 10000 peaks
    if (i % 10000 === 0) {
      self.postMessage({ type: 'progress', progress: i / numPeaks })
    }
  }

  self.postMessage({ type: 'done', peaks }, [peaks.buffer])
}
