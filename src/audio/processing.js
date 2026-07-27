import { getSegmentDuration } from './operations.js'
import { ensureLA2AWorklet } from './la2aWorkletLoader.js'
import { LA2A_DEFAULTS, toKernelParams } from './effects/la2aCompressor.js'

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
      // Clamp to actual buffer bounds, then bulk-copy via TypedArray.set().
      // This is orders of magnitude faster than a per-sample loop with
      // per-iteration bounds checks (effectively a memcpy vs. 32M JS calls).
      const actualSamples = Math.min(
        copySamples,
        srcData.length - sourceSampleStart,
        durationSamples - destSampleStart,
      )
      if (actualSamples > 0) {
        channelData[ch].set(
          srcData.subarray(sourceSampleStart, sourceSampleStart + actualSamples),
          destSampleStart,
        )
      }
    }
  }

  return channelData
}

/**
 * Encode a Float32 channel-data array as a 32-bit float WAV Blob.
 * Used to ship raw timeline audio to the server without lossy conversion.
 */
export function floatChannelsToWavBlob(channelData, sampleRate, channels) {
  const numSamples = channelData[0].length
  const bytesPerSample = 4 // 32-bit float
  const dataSize = numSamples * channels * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  // RIFF header
  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')

  // fmt chunk
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)         // chunk size
  view.setUint16(20, 3, true)          // IEEE float format
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)

  // data chunk
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  // Float32Array view onto the same ArrayBuffer — typed-array set/subarray
  // is effectively memcpy and orders of magnitude faster than per-sample
  // DataView.setFloat32 calls.  All modern CPUs are little-endian.
  const audioView = new Float32Array(buffer, 44)
  if (channels === 1) {
    audioView.set(channelData[0])
  } else {
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < channels; ch++) {
        audioView[i * channels + ch] = channelData[ch][i]
      }
    }
  }

  return new Blob([buffer], { type: 'audio/wav' })
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i))
  }
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
 * Measure the LA-2A auto-makeup gain (dB) for a region.
 *
 * Because this is a spot effect on a finite selection (not a live input),
 * the makeup can be measured once and applied as a static offset — the
 * real-time preview and the offline apply then use the identical constant,
 * so they stay sample-identical and there's no estimator drift baked into
 * the head of the region.
 *
 * Long regions are measured over a centered window rather than end to end:
 * the RMS ratio is stable across a representative stretch, and this keeps
 * the re-measure fast enough to sit behind a knob drag. The window only
 * affects how the number is derived — preview and apply still share it.
 */
const AUTO_MAKEUP_MAX_ANALYSIS_S = 30

export function computeLA2AAutoMakeup(segments, start, end, kernelParams, sampleRate, channels) {
  let aStart = start
  let aEnd = end
  if (end - start > AUTO_MAKEUP_MAX_ANALYSIS_S) {
    const mid = (start + end) / 2
    aStart = mid - AUTO_MAKEUP_MAX_ANALYSIS_S / 2
    aEnd = mid + AUTO_MAKEUP_MAX_ANALYSIS_S / 2
  }

  return new Promise((resolve, reject) => {
    const channelData = renderRegionToBuffer(segments, aStart, aEnd, sampleRate, channels)

    const worker = new Worker(
      new URL('../workers/processWorker.js', import.meta.url),
      { type: 'module' }
    )

    worker.onmessage = (e) => {
      worker.terminate()
      if (e.data.type === 'done') {
        resolve(e.data.makeupDb)
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }

    worker.postMessage(
      { type: 'la2aAutoMakeup', channelData, sampleRate, params: kernelParams },
      channelData.map(c => c.buffer)
    )
  })
}

/**
 * Apply LA-2A compression via OfflineAudioContext running the same
 * AudioWorklet as the real-time preview (src/audio/la2aProcessor.js), so
 * the applied result is sample-identical to what the user heard.
 */
export async function applyLA2ARegion(segments, start, end, params, sampleRate, channels) {
  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const duration = end - start
  const numSamples = Math.ceil(duration * sampleRate)

  const offlineCtx = new OfflineAudioContext(channels, numSamples, sampleRate)
  await ensureLA2AWorklet(offlineCtx)

  const inputBuffer = offlineCtx.createBuffer(channels, numSamples, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    inputBuffer.copyToChannel(channelData[ch], ch)
  }

  const source = offlineCtx.createBufferSource()
  source.buffer = inputBuffer

  const la2aNode = new AudioWorkletNode(offlineCtx, 'la2a-processor', {
    channelCount: channels,
    channelCountMode: 'explicit',
    outputChannelCount: [channels],
    processorOptions: { params: toKernelParams({ ...LA2A_DEFAULTS, ...params }) },
  })

  source.connect(la2aNode)
  la2aNode.connect(offlineCtx.destination)
  source.start(0)

  return await offlineCtx.startRendering()
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
