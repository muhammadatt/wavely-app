import { getSegmentDuration } from './operations.js'

/**
 * Render a region of the timeline to a flat PCM buffer.
 * Used before applying processing effects.
 */
export function renderRegionToBuffer(segments, start, end, sampleRate, channels) {
  const durationSamples = Math.ceil((end - start) * sampleRate)
  const channelData = []
  for (let ch = 0; ch < channels; ch++) {
    channelData.push(new Float32Array(durationSamples))
  }

  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur

    // Skip segments outside range
    if (segEnd <= start || seg.outputStart >= end) continue

    if (seg.sourceBuffer === null) continue // silence

    // Calculate overlap
    const overlapStart = Math.max(start, seg.outputStart)
    const overlapEnd = Math.min(end, segEnd)

    const sourceOffset = seg.sourceStart + (overlapStart - seg.outputStart)
    const destOffset = overlapStart - start

    const sourceSampleStart = Math.floor(sourceOffset * sampleRate)
    const destSampleStart = Math.floor(destOffset * sampleRate)
    const copySamples = Math.floor((overlapEnd - overlapStart) * sampleRate)

    for (let ch = 0; ch < channels; ch++) {
      const srcData = seg.sourceBuffer.getChannelData(ch)
      for (let i = 0; i < copySamples; i++) {
        const si = sourceSampleStart + i
        const di = destSampleStart + i
        if (si < srcData.length && di < durationSamples) {
          channelData[ch][di] = srcData[si]
        }
      }
    }
  }

  return channelData
}

/**
 * Normalize a region of the timeline.
 * Returns a Promise that resolves to the processed AudioBuffer.
 */
export function normalizeRegion(segments, start, end, targetPeakDb, audioContext, sampleRate, channels) {
  return new Promise((resolve, reject) => {
    const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)

    const worker = new Worker(
      new URL('../workers/processWorker.js', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e) => {
      if (e.data.type === 'done') {
        const duration = end - start
        const buffer = audioContext.createBuffer(channels, Math.ceil(duration * sampleRate), sampleRate)

        for (let ch = 0; ch < channels; ch++) {
          buffer.copyToChannel(e.data.channelData[ch], ch)
        }

        worker.terminate()
        resolve(buffer)
      } else if (e.data.type === 'error') {
        worker.terminate()
        reject(new Error(e.data.message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }

    worker.postMessage(
      { type: 'normalize', channelData, params: { targetPeakDb } },
      channelData.map(c => c.buffer)
    )
  })
}

/**
 * Adjust the volume of a region by a dB amount.
 * Returns a Promise that resolves to the processed AudioBuffer.
 */
export function adjustVolumeRegion(segments, start, end, gainDb, audioContext, sampleRate, channels) {
  return new Promise((resolve, reject) => {
    const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)

    const worker = new Worker(
      new URL('../workers/processWorker.js', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e) => {
      if (e.data.type === 'done') {
        const duration = end - start
        const buffer = audioContext.createBuffer(channels, Math.ceil(duration * sampleRate), sampleRate)

        for (let ch = 0; ch < channels; ch++) {
          buffer.copyToChannel(e.data.channelData[ch], ch)
        }

        worker.terminate()
        resolve(buffer)
      } else if (e.data.type === 'error') {
        worker.terminate()
        reject(new Error(e.data.message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }

    worker.postMessage(
      { type: 'adjustVolume', channelData, params: { gainDb } },
      channelData.map(c => c.buffer)
    )
  })
}

/**
 * Compress a region using OfflineAudioContext + DynamicsCompressorNode.
 */
export async function compressRegion(segments, start, end, params, audioContext, sampleRate, channels) {
  const { threshold = -24, ratio = 12, attack = 0.003, release = 0.25 } = params

  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const duration = end - start
  const numSamples = Math.ceil(duration * sampleRate)

  // Create an OfflineAudioContext
  const offlineCtx = new OfflineAudioContext(channels, numSamples, sampleRate)

  // Create source buffer
  const inputBuffer = offlineCtx.createBuffer(channels, numSamples, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    inputBuffer.copyToChannel(channelData[ch], ch)
  }

  const source = offlineCtx.createBufferSource()
  source.buffer = inputBuffer

  // Create compressor
  const compressor = offlineCtx.createDynamicsCompressor()
  compressor.threshold.setValueAtTime(threshold, 0)
  compressor.ratio.setValueAtTime(ratio, 0)
  compressor.attack.setValueAtTime(attack, 0)
  compressor.release.setValueAtTime(release, 0)

  source.connect(compressor)
  compressor.connect(offlineCtx.destination)
  source.start(0)

  const renderedBuffer = await offlineCtx.startRendering()
  return renderedBuffer
}

/**
 * Compute peak cache for an AudioBuffer using a Web Worker.
 */
export function computePeakCache(audioBuffer, samplesPerPx) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/peakWorker.js', import.meta.url),
      { type: 'module' }
    )

    const channelData = []
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      // Copy channel data since we can't transfer AudioBuffer data directly
      const data = new Float32Array(audioBuffer.length)
      audioBuffer.copyFromChannel(data, ch)
      channelData.push(data)
    }

    worker.onmessage = (e) => {
      if (e.data.type === 'done') {
        worker.terminate()
        resolve({
          samplesPerPx,
          peaks: e.data.peaks,
        })
      } else if (e.data.type === 'progress') {
        // Could forward progress if needed
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }

    worker.postMessage(
      {
        channelData,
        samplesPerPx,
        totalSamples: audioBuffer.length,
      },
      channelData.map(c => c.buffer)
    )
  })
}
