import { getSegmentDuration } from './operations.js'
import { ensureLA2AWorklet } from './la2aWorkletLoader.js'
import {
  LA2A_DEFAULTS, LA2A_LATENCY_SAMPLES, toKernelParams,
} from './effects/la2aCompressor.js'
import { ensureFET1176Worklet } from './fet1176WorkletLoader.js'
import {
  FET1176_DEFAULTS,
  FET1176_LATENCY_SAMPLES,
  toKernelParams as toFET1176KernelParams,
} from './effects/fet1176Compressor.js'
import { ensureSoftClipperWorklet } from './softClipperWorkletLoader.js'
import {
  SOFT_CLIPPER_DEFAULTS,
  SOFT_CLIPPER_LATENCY_SAMPLES,
  toKernelParams as toSoftClipperKernelParams,
} from './effects/softClipper.js'
import { ensureAirBandWorklet } from './airBandWorkletLoader.js'
import {
  AIR_BAND_DEFAULTS,
  toKernelParams as toAirBandKernelParams,
} from './effects/airBand.js'
import { ensureSchepsWorklet } from './schepsWorkletLoader.js'
import {
  SCHEPS_DEFAULTS,
  SCHEPS_LATENCY_SAMPLES,
  toKernelParams as toSchepsKernelParams,
} from './effects/scheps.js'
import { ensureVocalSatWorklet } from './vocalSatWorkletLoader.js'
import {
  VOCAL_SAT_DEFAULTS,
  VOCAL_SAT_LATENCY_SAMPLES,
  toKernelParams as toVocalSatKernelParams,
} from './effects/vocalSat.js'
import { ensureResonanceWorklet } from './resonanceWorkletLoader.js'
import {
  RESONANCE_DEFAULTS,
  RESONANCE_LATENCY_SAMPLES,
  toKernelParams as toResonanceKernelParams,
} from './effects/resonance.js'
import { ensureHumNotchWorklet } from './humNotchWorkletLoader.js'
import {
  HUM_NOTCH_DEFAULTS,
  toKernelParams as toHumNotchKernelParams,
} from './effects/humNotch.js'
import { ensureManualEqWorklet } from './eqWorkletLoader.js'
import {
  MANUAL_EQ_DEFAULTS,
  EQ_LATENCY_SAMPLES,
  toKernelParams as toManualEqKernelParams,
} from './effects/manualEq.js'
import { MAX_ANALYSIS_SECONDS as HUM_MAX_ANALYSIS_SECONDS } from './dsp/humDetect.js'

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

/**
 * Run one measurement pass over a region in the processing worker and resolve
 * whatever it reports. Shared by every measured-parameter path — the compressor
 * auto-makeups and the Scheps wet trim — which differ only in the kernel they
 * run and the numbers they hand back.
 */
function measureInWorker(workerType, segments, start, end, kernelParams, sampleRate, channels) {
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
        resolve(e.data)
      } else if (e.data.type === 'error') {
        reject(new Error(e.data.message))
      }
    }

    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }

    worker.postMessage(
      { type: workerType, channelData, sampleRate, params: kernelParams },
      channelData.map(c => c.buffer)
    )
  })
}

export function computeLA2AAutoMakeup(segments, start, end, kernelParams, sampleRate, channels) {
  return measureInWorker('la2aAutoMakeup', segments, start, end, kernelParams, sampleRate, channels)
    .then(d => d.makeupDb)
}

/** Measure the FET Punch auto-makeup (Output) for a region — see above. */
export function computeFET1176AutoMakeup(segments, start, end, kernelParams, sampleRate, channels) {
  return measureInWorker('fet1176AutoMakeup', segments, start, end, kernelParams, sampleRate, channels)
    .then(d => d.makeupDb)
}

/**
 * Measure the Scheps wet-path makeup, the dry/wet correlation and the density
 * the compression yields, for a region. Resolves
 * `{ trimDb, correlation, densityDb }` — see computeSchepsAutoTrim.
 */
export function computeSchepsTrim(segments, start, end, kernelParams, sampleRate, channels) {
  return measureInWorker('schepsAutoTrim', segments, start, end, kernelParams, sampleRate, channels)
    .then(d => ({ trimDb: d.trimDb, correlation: d.correlation, densityDb: d.densityDb }))
}

/**
 * Where a soft clipper ceiling preset lands for a region, in dBFS. Resolves
 * null if the region has no measurable content.
 *
 * ⚠ THE ANALYSIS WINDOW IS CAPPED like every other measured parameter's (see
 * AUTO_MAKEUP_MAX_ANALYSIS_S), so on a long region this is a centred excerpt
 * rather than the whole thing. Harmless for a percentile of block peaks, and
 * DETERMINISTIC — which matters because the user can nudge the ceiling
 * afterwards and must not find it moving under them.
 */
export function computeSoftClipperCeiling(segments, start, end, percentile, sampleRate, channels) {
  return measureInWorker('softClipperCeiling', segments, start, end, { percentile }, sampleRate, channels)
    .then(d => (Number.isFinite(d.ceilingDb) ? d.ceilingDb : null))
}

/**
 * Render a region through an effect's worklet in an OfflineAudioContext.
 *
 * Every effect applies this way, running the exact same worklet module as the
 * real-time preview, so the applied result is sample-identical to what the
 * user heard.
 *
 * LATENCY. An effect that reports `latencySamples > 0` emits output that lags
 * its input — the resonance suppressor's STFT holds back a full fftSize before
 * a sample is fully reconstructed. Rendering exactly `numSamples` would then
 * write back audio shifted late by that much, with the tail cut off: silence
 * spliced in at the head of the region and the last `latency` samples of real
 * audio lost. So the render is extended, the region is extended to match (real
 * audio where the timeline has it, silence past the end), and the leading
 * `latency` samples are dropped from the result.
 *
 * Zero-latency effects take the original path untouched — no extra render, no
 * copy.
 */
async function applyWorkletRegion(
  segments, start, end, sampleRate, channels,
  { ensureWorklet, processorName, kernelParams, latencySamples = 0 },
) {
  const duration = end - start
  const numSamples = Math.ceil(duration * sampleRate)
  const latency = Math.max(0, Math.round(latencySamples))
  const renderSamples = numSamples + latency

  // Pull `latency` extra samples of real audio from past the region where the
  // timeline has them, so the tail is reconstructed from context rather than
  // from silence. renderRegionToBuffer zero-fills beyond the end of the
  // timeline, which is exactly what we want there.
  const channelData = renderRegionToBuffer(
    segments, start, end + latency / sampleRate, sampleRate, channels,
  )

  const offlineCtx = new OfflineAudioContext(channels, renderSamples, sampleRate)
  await ensureWorklet(offlineCtx)

  const inputBuffer = offlineCtx.createBuffer(channels, renderSamples, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    // renderRegionToBuffer sizes to ceil() of the extended duration, which can
    // differ from renderSamples by a sample; copy only what fits.
    const src = channelData[ch]
    inputBuffer.copyToChannel(
      src.length > renderSamples ? src.subarray(0, renderSamples) : src,
      ch,
    )
  }

  const source = offlineCtx.createBufferSource()
  source.buffer = inputBuffer

  const node = new AudioWorkletNode(offlineCtx, processorName, {
    channelCount: channels,
    channelCountMode: 'explicit',
    outputChannelCount: [channels],
    processorOptions: { params: kernelParams },
  })

  source.connect(node)
  node.connect(offlineCtx.destination)
  source.start(0)

  const rendered = await offlineCtx.startRendering()
  if (latency === 0) return rendered

  // Drop the leading `latency` samples so output sample 0 corresponds to input
  // sample 0, and hand back a buffer of exactly the region's length — that is
  // what replaceRegion expects to splice in.
  const trimmed = offlineCtx.createBuffer(channels, numSamples, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    trimmed.copyToChannel(
      rendered.getChannelData(ch).subarray(latency, latency + numSamples),
      ch,
    )
  }
  return trimmed
}

/** Apply OptoSmooth (LA-2A) compression to a region. */
export function applyLA2ARegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureLA2AWorklet,
    processorName: 'la2a-processor',
    kernelParams: toKernelParams({ ...LA2A_DEFAULTS, ...params }),
    latencySamples: LA2A_LATENCY_SAMPLES,
  })
}

/** Apply FET Punch (1176) compression to a region. */
export function applyFET1176Region(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureFET1176Worklet,
    processorName: 'fet1176-processor',
    kernelParams: toFET1176KernelParams({ ...FET1176_DEFAULTS, ...params }),
    latencySamples: FET1176_LATENCY_SAMPLES,
  })
}

/** Apply the Adaptive Soft Clipper to a region. */
export function applySoftClipperRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureSoftClipperWorklet,
    processorName: 'soft-clipper-processor',
    kernelParams: toSoftClipperKernelParams({ ...SOFT_CLIPPER_DEFAULTS, ...params }),
    latencySamples: SOFT_CLIPPER_LATENCY_SAMPLES,
  })
}

/** Apply Air Band to a region. */
export function applyAirBandRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureAirBandWorklet,
    processorName: 'air-band-processor',
    kernelParams: toAirBandKernelParams({ ...AIR_BAND_DEFAULTS, ...params }),
  })
}

/** Apply Scheps Parallel to a region. */
export function applySchepsRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureSchepsWorklet,
    processorName: 'scheps-processor',
    kernelParams: toSchepsKernelParams({ ...SCHEPS_DEFAULTS, ...params }),
    latencySamples: SCHEPS_LATENCY_SAMPLES,
  })
}

/** Apply Vocal Saturation to a region. */
export function applyVocalSatRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureVocalSatWorklet,
    processorName: 'vocal-sat-processor',
    kernelParams: toVocalSatKernelParams({ ...VOCAL_SAT_DEFAULTS, ...params }),
    latencySamples: VOCAL_SAT_LATENCY_SAMPLES,
  })
}

/**
 * Apply the manual EQ to a region.
 *
 * `soloIndex` is deliberately not forwarded: solo is a monitoring state, and
 * committing a bandpass-monitored selection to the timeline is never what the
 * user meant by "Apply".
 */
export function applyManualEqRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureManualEqWorklet,
    processorName: 'manual-eq-processor',
    kernelParams: toManualEqKernelParams({
      ...MANUAL_EQ_DEFAULTS, ...params, soloIndex: null,
    }),
    latencySamples: EQ_LATENCY_SAMPLES,
  })
}

/** Apply Hum Remover notches to a region. */
export function applyHumNotchRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureHumNotchWorklet,
    processorName: 'hum-notch-processor',
    kernelParams: toHumNotchKernelParams({ ...HUM_NOTCH_DEFAULTS, ...params }),
  })
}

/**
 * Apply the clip-gain de-esser envelope to a region.
 *
 * No OfflineAudioContext render here, unlike every other apply path. Preview
 * drives a GainNode's AudioParam from the envelope buffer, and that was
 * measured to be bit-identical to multiplying the arrays (maxErr 0), so the
 * multiply IS the preview — routing it through a worklet would add a graph and
 * a promise to reach the same samples.
 *
 * @param {Array}  segments
 * @param {number} start           region start (seconds)
 * @param {number} end             region end (seconds)
 * @param {Float32Array} deviation envelope as deviation from unity, region-aligned
 * @param {number} sampleRate
 * @param {number} channels
 * @returns {AudioBuffer}
 */
export function applyDeEsserRegion(segments, start, end, deviation, sampleRate, channels) {
  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const numSamples = channelData[0].length

  const ctx = new OfflineAudioContext(channels, numSamples, sampleRate)
  const out = ctx.createBuffer(channels, numSamples, sampleRate)

  const n = Math.min(numSamples, deviation.length)
  for (let ch = 0; ch < channels; ch++) {
    const src = channelData[ch]
    const dst = out.getChannelData(ch)
    for (let i = 0; i < n; i++) dst[i] = src[i] * (1 + deviation[i])
    // Envelope shorter than the region (or absent) leaves the tail untouched,
    // matching what an ended modulator does during preview.
    for (let i = n; i < numSamples; i++) dst[i] = src[i]
  }

  return out
}

/**
 * Analyse a region for mains hum in a Worker.
 *
 * Only a bounded window is rendered. detectHum examines at most
 * MAX_ANALYSIS_SECONDS regardless of what it is handed, so rendering the whole
 * selection would make memory scale with selection length for no benefit —
 * selecting a whole chapter and analysing would allocate hundreds of MB
 * (a 60-minute mono selection is ~635 MB for the render plus as much again for
 * the mixdown) to then throw all but ten seconds of it away.
 *
 * The window is centred rather than taken from the head, matching
 * computeAutoMakeup above: hum is stationary so any representative stretch
 * will do, and the middle of a selection is less likely to be lead-in silence.
 *
 * Mono mixdown happens here rather than in the worker so only one channel of
 * samples crosses the boundary, and it is transferred rather than copied.
 *
 * @returns {Promise<object>} the detectHum() result — see src/audio/dsp/humDetect.js
 */
export function analyzeHumRegion(segments, start, end, sampleRate, channels, options = {}) {
  let aStart = start
  let aEnd = end
  if (end - start > HUM_MAX_ANALYSIS_SECONDS) {
    const mid = (start + end) / 2
    aStart = mid - HUM_MAX_ANALYSIS_SECONDS / 2
    aEnd = mid + HUM_MAX_ANALYSIS_SECONDS / 2
  }

  const channelData = renderRegionToBuffer(segments, aStart, aEnd, sampleRate, channels)

  // Mono mixdown — hum is common-mode, and the detector expects one channel.
  const n = channelData[0].length
  const mono = new Float32Array(n)
  for (const ch of channelData) {
    for (let i = 0; i < n; i++) mono[i] += ch[i]
  }
  if (channels > 1) {
    const scale = 1 / channels
    for (let i = 0; i < n; i++) mono[i] *= scale
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL('../workers/humWorker.js', import.meta.url),
      { type: 'module' },
    )
    worker.onmessage = (e) => {
      worker.terminate()
      if (e.data.type === 'done') resolve(e.data.result)
      else reject(new Error(e.data.message))
    }
    worker.onerror = (err) => {
      worker.terminate()
      reject(err)
    }
    worker.postMessage({ samples: mono, sampleRate, options }, [mono.buffer])
  })
}

/**
 * Apply Resonance Suppression to a region.
 *
 * Its STFT delays the output by a full frame, which applyWorkletRegion renders
 * long and trims. The two compressors do the same for their oversamplers.
 */
export function applyResonanceRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureResonanceWorklet,
    processorName: 'resonance-processor',
    kernelParams: toResonanceKernelParams({ ...RESONANCE_DEFAULTS, ...params }),
    latencySamples: RESONANCE_LATENCY_SAMPLES,
  })
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
          // One Float32Array per channel. The renderer indexes this by lane.
          channels: e.data.peaks,
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
