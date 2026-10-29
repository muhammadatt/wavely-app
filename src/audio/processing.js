import { getSegmentDuration } from './operations.js'
import { applyGainSegments } from './dsp/autoLevel.js'
import { analysisWindow, analysedWholeRegion, regionPeakDb } from './analysisWindow.js'
import { ensureLA2AWorklet } from './la2aWorkletLoader.js'
import { LA2A_PREROLL_S } from './la2aProcessor.js'
// ⚠ From the PROCESSOR, not the effect wrapper — the wrapper pulls the worklet
// URL and does not re-export kernel constants. Same shape as LA2A_PREROLL_S.
import { FET1176_PREROLL_S } from './fet1176Processor.js'
import { restorePeakToCeiling } from './dsp/makeupReference.js'
import {
  LA2A_DEFAULTS, la2aPatchLatencySamples, toKernelParams,
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
  softClipperLatencySamples,
  toKernelParams as toSoftClipperKernelParams,
} from './effects/softClipper.js'
import { ensureAirBandWorklet } from './airBandWorkletLoader.js'
import { ensureSaturationBenchWorklet } from './saturationBenchWorkletLoader.js'
import {
  SATURATION_BENCH_DEFAULTS,
  toKernelParams as toSaturationBenchKernelParams,
} from './effects/saturationBench.js'
import { SAT_BENCH_LATENCY_SAMPLES, SAT_BENCH_PREROLL_S } from './saturationBenchProcessor.js'
import {
  AIR_BAND_DEFAULTS,
  toKernelParams as toAirBandKernelParams,
} from './effects/airBand.js'
import { ensureHFSoftenerWorklet } from './deEsserWorkletLoader.js'
import { HF_SOFTENER_PREROLL_S } from './deEsserProcessor.js'
import { HF_RESO_FRAME_SIZE, HF_RESO_LATENCY_SAMPLES } from './deEsserResoStage.js'
import {
  HF_SOFTENER_DEFAULTS,
  toKernelParams as toHFSoftenerKernelParams,
  resoOn, resoKernelParams, softenOn, softenStageKernelParams,
} from './effects/deEsser.js'
import { softenLatencySamples } from './deEsserSoftenStage.js'
import { ensureHFLimiterWorklet } from './hfLimiterWorkletLoader.js'
import {
  HF_LIMITER_DEFAULTS,
  HF_LIMITER_PREROLL_S,
  hfLimiterLatencySamples,
  toKernelParams as toHFLimiterKernelParams,
} from './hfLimiterParams.js'
import { ensurePlosiveWorklet } from './plosiveWorkletLoader.js'
import {
  PLOSIVE_DEFAULTS, PLOSIVE_PREROLL_S, plosiveLatencySamples,
  toKernelParams as toPlosiveKernelParams,
} from './plosiveParams.js'
import { ensurePhatassWorklet } from './phatassWorkletLoader.js'
import {
  PHATASS_DEFAULTS,
  PHATASS_PREROLL_S,
  phatassLatencySamples,
  toKernelParams as toPhatassKernelParams,
} from './phatassParams.js'
import { READOUT_WHOLE_MAX_S, readoutBlocks } from './phatassWarmthReadout.js'
import {
  chunkCount,
  planChunks,
} from './chunkedApply.js'
import { RESONANCE_FRAME_SIZE, resonanceHopSamples } from './resonanceParams.js'
import { ensureSchepsWorklet } from './schepsWorkletLoader.js'
import { ensureVoxPressorWorklet } from './voxPressorWorkletLoader.js'
import { voxLatencySamples, toKernelParams as toVoxKernelParams, VOX_DEFAULTS } from './effects/voxPressorParams.js'
import { SCHEPS_PREROLL_S } from './schepsProcessor.js'
import {
  SCHEPS_DEFAULTS,
  SCHEPS_LATENCY_SAMPLES,
  toKernelParams as toSchepsKernelParams,
} from './effects/scheps.js'
import { ensureVocalSatWorklet } from './vocalSatWorkletLoader.js'
import { ensureInflatorWorklet } from './inflatorWorkletLoader.js'
import {
  VOCAL_SAT_DEFAULTS,
  VOCAL_SAT_LATENCY_SAMPLES,
  VOCAL_SAT_PREROLL_S,
  toKernelParams as toVocalSatKernelParams,
} from './effects/vocalSat.js'
import {
  INFLATOR_DEFAULTS,
  INFLATOR_LATENCY_SAMPLES,
  toKernelParams as toInflatorKernelParams,
} from './effects/inflator.js'
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
 * Render a region down to the mono 16 kHz 16-bit WAV that voice-activity
 * detection actually consumes.
 *
 * ⚠ THE FULL-RATE FLOAT UPLOAD DOES NOT FIT DOWN THE PIPE. `floatChannelsToWavBlob`
 * writes 32-bit float, so half an hour of mono at 44.1 kHz is 318 MB and an hour
 * is 635 MB — against an upload limit, a proxy timeout and a user's uplink. The
 * Auto Leveler is FOR chapter-length selections, so that is the ordinary case
 * rather than an edge one.
 *
 * Nothing is lost that the detector would have used: Silero v5 runs at 16 kHz
 * mono, and the server resamples to exactly this before calling it
 * (`decodeToFloat32Mono16k`). Sending it pre-resampled removes a conversion
 * rather than adding one, and takes an hour-long chapter to 110 MB (measured, not estimated).
 *
 * ⚠ ONE MEASUREMENT DOES RIDE ALONG AND IS AFFECTED. The same route returns the
 * noise floor, measured on what it receives — so it is measured without the
 * content above 8 kHz. Room tone is broadband, so a floor read this way lands a
 * fraction of a dB LOW, which makes the leveler's headroom cap marginally more
 * permissive rather than more conservative. It is a safety rail whose target the
 * user sets and can see, not a precision reading, so a sub-dB shift in it is
 * accepted here deliberately; if that ever stops being true, measure the floor
 * client-side off the full-rate render instead of narrowing this upload.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate  the project's rate
 * @returns {Promise<Blob>}
 */
export async function renderVadWavBlob(channelData, sampleRate) {
  const numSamples = channelData[0].length
  const channels = channelData.length

  // Mono first: VAD is a single-channel decision, and mixing before the
  // resample is one pass over the data instead of one per channel.
  const mono = new Float32Array(numSamples)
  if (channels === 1) {
    mono.set(channelData[0])
  } else {
    for (let i = 0; i < numSamples; i++) {
      let sum = 0
      for (let c = 0; c < channels; c++) sum += channelData[c][i]
      mono[i] = sum / channels
    }
  }

  const outLength = Math.max(1, Math.round((numSamples * VAD_SAMPLE_RATE) / sampleRate))
  const ctx = new OfflineAudioContext(1, outLength, VAD_SAMPLE_RATE)
  const buffer = ctx.createBuffer(1, numSamples, sampleRate)
  buffer.copyToChannel(mono, 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  source.start()
  const rendered = await ctx.startRendering()

  return pcm16WavBlob(rendered.getChannelData(0), VAD_SAMPLE_RATE)
}

/** Silero v5's native rate. Resampling past this would throw information away. */
const VAD_SAMPLE_RATE = 16000

/**
 * Mono 16-bit PCM WAV.
 *
 * 16-bit rather than float because this is only ever read by a detector whose
 * decisions live far above the -96 dBFS quantisation floor, and it halves the
 * upload again.
 */
function pcm16WavBlob(samples, sampleRate) {
  const n = samples.length
  const dataSize = n * 2
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)            // PCM
  view.setUint16(22, 1, true)            // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)            // block align
  view.setUint16(34, 16, true)           // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  for (let i = 0; i < n; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
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
 * Long regions are measured over a capped window rather than end to end, which
 * keeps the re-measure fast enough to sit behind a knob drag. The window only
 * affects how the number is derived — preview and apply still share it.
 */

/**
 * Run one measurement pass over a region in the processing worker and resolve
 * whatever it reports. Shared by every measured-parameter path — the compressor
 * auto-makeups and the Scheps wet trim — which differ only in the kernel they
 * run and the numbers they hand back.
 */
/**
 * The measurement worker, kept alive between passes.
 *
 * ⚠ IT USED TO BE SPAWNED AND TERMINATED PER MEASUREMENT, and that cost 86 ms
 * of every pass doing nothing — measured in the browser on a warm module cache,
 * against 240 ms of actual DSP. Under a knob drag that is a worker construction
 * and a module-graph load every couple of hundred milliseconds, for no benefit.
 *
 * One worker, serialised: with the per-plugin throttles there is at most one
 * pass in flight per plugin, and two plugins measuring at once are better off
 * queued than competing for cores. A failed pass terminates it so the next call
 * gets a clean one — a wedged singleton would freeze every measured parameter
 * in the app for the rest of the session.
 */
let measureWorker = null
let measureSeq = 0
const measurePending = new Map()

function getMeasureWorker() {
  if (measureWorker) return measureWorker
  measureWorker = new Worker(
    new URL('../workers/processWorker.js', import.meta.url),
    { type: 'module' }
  )
  measureWorker.onmessage = (e) => {
    const { __id, ...data } = e.data ?? {}
    const entry = measurePending.get(__id)
    if (!entry) return
    measurePending.delete(__id)
    if (data.type === 'done') entry.resolve(data)
    else entry.reject(new Error(data.message ?? 'measurement failed'))
  }
  measureWorker.onerror = (err) => {
    // Fail every waiter rather than leaving them pending forever, then drop the
    // worker so the next call builds a fresh one.
    for (const entry of measurePending.values()) entry.reject(err)
    measurePending.clear()
    measureWorker?.terminate()
    measureWorker = null
  }
  return measureWorker
}

function measureInWorker(workerType, segments, start, end, kernelParams, sampleRate, channels) {
  const { start: aStart, end: aEnd } = analysisWindow(start, end)

  return new Promise((resolve, reject) => {
    const channelData = renderRegionToBuffer(segments, aStart, aEnd, sampleRate, channels)
    const id = ++measureSeq
    measurePending.set(id, { resolve, reject })
    getMeasureWorker().postMessage(
      { __id: id, type: workerType, channelData, sampleRate, params: kernelParams },
      channelData.map(c => c.buffer)
    )
  })
}

/**
 * The same round trip over the WHOLE region, with no analysis cap.
 *
 * ⚠ THE CAP IS NOT AN OPTIMISATION THAT CAN BE APPLIED EVERYWHERE. It is right
 * for a measured knob position, which asks "what is this setting doing" and is
 * answered as well by a representative half-minute. It is wrong for anything
 * that is a statement about the region as a whole: integrated loudness and
 * ACX's ungated RMS are both defined over all of it, and measuring thirty
 * seconds of a chapter that opens loud reads hot and normalizes the rest of
 * the recording down to match. Two functions rather than a flag, so the
 * decision is visible at every call site.
 */
function measureWholeRegionInWorker(workerType, segments, start, end, params, sampleRate, channels) {
  return new Promise((resolve, reject) => {
    const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
    const id = ++measureSeq
    measurePending.set(id, { resolve, reject })
    getMeasureWorker().postMessage(
      { __id: id, type: workerType, channelData, sampleRate, params },
      channelData.map(c => c.buffer)
    )
  })
}

/**
 * Every loudness reading for a region — integrated LUFS, ACX's ungated RMS,
 * sample peak and true peak. Resolves the shape `measureLoudness` in
 * dsp/loudness.js returns.
 */
export function measureRegionLoudness(segments, start, end, sampleRate, channels) {
  return measureWholeRegionInWorker(
    'measureLoudness', segments, start, end, {}, sampleRate, channels,
  ).then(d => d.loudness)
}

/**
 * Normalize a region to a loudness target and resolve `{ buffer, report }`.
 *
 * ⚠ THE REPORT IS MEASURED ON THE RENDERED OUTPUT, not predicted from the gain,
 * and the panel prints it verbatim. Where the peak ceiling forced limiting, the
 * loudness that came out is not the loudness the gain aimed at — see
 * dsp/loudnessNormalize.js — and a panel that reported the aim would be telling
 * a narrator they had hit a spec somebody else is about to measure.
 *
 * @param {{targetDb:number, unit:'LUFS'|'RMS', ceilingDb:number}} target
 * @param {'limit'|'safe'} peakMode
 */
export function loudnessNormalizeRegion(
  segments, start, end, target, peakMode, audioContext, sampleRate, channels,
) {
  return measureWholeRegionInWorker(
    'loudnessNormalize', segments, start, end, { target, peakMode }, sampleRate, channels,
  ).then((d) => {
    const buffer = audioContext.createBuffer(
      channels, Math.ceil((end - start) * sampleRate), sampleRate,
    )
    for (let ch = 0; ch < channels; ch++) buffer.copyToChannel(d.channelData[ch], ch)
    return { buffer, report: d.report }
  })
}

/**
 * Measure OptoSmooth's auto-makeup for a region. Resolves
 * `{ makeupDb, ceilingDb, ceilingKneeDb }`.
 *
 * The knee travels with the ceiling and must not be dropped: without it the
 * kernel falls back to the widest fixed width, which costs peak headroom
 * silently. See `ceilingKneeDbFor`.
 *
 * ⚠ THE TWO HALVES ARE MEASURED OVER DIFFERENT SPANS, DELIBERATELY. The makeup
 * comes from the worker's capped, start-anchored window, because solving it
 * means running the kernel and that has to stay fast enough to sit behind a
 * knob drag. The ceiling comes from `regionPeakDb` over the WHOLE region,
 * because it is the guarantee — "never louder than the source" is a claim about
 * the source, not about the first thirty seconds of it. See both functions for
 * why each span is right for its job.
 *
 * `ceilingDb` is null under the peak reference, which needs no ceiling: its
 * guarantee is arithmetic. See `peakOfChannels` in dsp/makeupReference.js.
 */
export function computeLA2AAutoMakeup(
  segments, start, end, kernelParams, sampleRate, channels, reference = 'peak',
) {
  return measureInWorker(
    'la2aAutoMakeup', segments, start, end, { ...kernelParams, reference }, sampleRate, channels,
  ).then((d) => {
    if (reference !== 'percentile') {
      return { makeupDb: d.makeupDb, ceilingDb: null, ceilingKneeDb: null }
    }
    const ceilingDb = regionPeakDb(segments, start, end, sampleRate, channels)
    return {
      makeupDb: d.makeupDb,
      ceilingDb: Number.isFinite(ceilingDb) ? ceilingDb : null,
      /**
       * The measured width only when the solve saw everything the ceiling was
       * measured over — see `analysedWholeRegion`. Null is the conservative
       * fixed knee, which is what this did before the width was measured at all.
       */
      ceilingKneeDb: Number.isFinite(d.ceilingKneeDb) && analysedWholeRegion(start, end)
        ? d.ceilingKneeDb
        : null,
    }
  })
}

/**
 * Measure FET Punch's auto-makeup for a region. Resolves
 * `{ makeupDb, ceilingDb, ceilingKneeDb }`.
 *
 * ⚠ THE SAME CONTRACT AS `computeLA2AAutoMakeup`, DELIBERATELY — read its note
 * for all of it. The two halves are measured over different spans (makeup from
 * the worker's capped window because solving it means running the kernel; the
 * ceiling over the WHOLE region because "never louder than the source" is a
 * claim about the source, not about its first thirty seconds), and the knee
 * must not be dropped or the kernel silently falls back to the widest fixed
 * width and every render loses peak headroom.
 *
 * `ceilingDb` is null under the peak reference, which needs no ceiling.
 */
export function computeFET1176AutoMakeup(
  segments, start, end, kernelParams, sampleRate, channels, reference = 'peak',
) {
  return measureInWorker(
    'fet1176AutoMakeup', segments, start, end, { ...kernelParams, reference }, sampleRate, channels,
  ).then((d) => {
    if (reference !== 'percentile') {
      return { makeupDb: d.makeupDb, ceilingDb: null, ceilingKneeDb: null }
    }
    const ceilingDb = regionPeakDb(segments, start, end, sampleRate, channels)
    return {
      makeupDb: d.makeupDb,
      ceilingDb: Number.isFinite(ceilingDb) ? ceilingDb : null,
      // The measured width only when the solve saw everything the ceiling was
      // measured over — see `analysedWholeRegion`.
      ceilingKneeDb: Number.isFinite(d.ceilingKneeDb) && analysedWholeRegion(start, end)
        ? d.ceilingKneeDb
        : null,
    }
  })
}

/**
 * Measure the Soft Clipper's auto makeup (Output) for a region.
 *
 * Shares measureInWorker's 30 s centred cap like every other measured
 * parameter. Right for this one: the makeup is the region's peak reduction,
 * and a representative half-minute of a long take answers that as well as the
 * whole thing while staying fast enough to sit behind a knob drag.
 */
export function computeSoftClipperAutoMakeup(segments, start, end, kernelParams, sampleRate, channels) {
  return measureInWorker('softClipperAutoMakeup', segments, start, end, kernelParams, sampleRate, channels)
    .then(d => d.makeupDb)
}

/**
 * Measure the Scheps wet-path makeup, the dry/wet correlation and the density
 * the compression yields, for a region. Resolves
 * `{ trimDb, correlation, densityDb, ceilingDb, ceilingKneeDb }` — see
 * computeSchepsAutoTrim. The last two travel together: the ceiling is the
 * guarantee and the knee is how softly it is enforced.
 */
export function computeSchepsTrim(segments, start, end, kernelParams, sampleRate, channels) {
  return measureInWorker('schepsAutoTrim', segments, start, end, kernelParams, sampleRate, channels)
    .then((d) => {
      /**
       * ⚠ THE CEILING IS RE-MEASURED OVER THE WHOLE REGION, exactly as
       * `computeLA2AAutoMakeup` does and for the same reason: the worker only
       * ever sees the capped, start-anchored analysis window, and a ceiling from
       * an excerpt would clamp everything after it. The trim keeps the capped
       * pass because solving it renders the wet path and has to stay fast.
       */
      const ceilingDb = regionPeakDb(segments, start, end, sampleRate, channels)
      return {
        trimDb: d.trimDb,
        correlation: d.correlation,
        densityDb: d.densityDb,
        ceilingDb: Number.isFinite(ceilingDb) ? ceilingDb : null,
        // Same span guard as the OptoSmooth solve, for the same reason.
        ceilingKneeDb: Number.isFinite(d.ceilingKneeDb) && analysedWholeRegion(start, end)
          ? d.ceilingKneeDb
          : null,
      }
    })
}

/**
 * Solve VoxPressor for a region: what Peaks and Body mean on this recording.
 * Resolves `solveVoxPressor`'s result (see voxPressorSolve.js) with the
 * limiters' ceiling re-measured over the WHOLE region.
 *
 * ⚠ THE SAME TWO-SPAN CONTRACT AS `computeLA2AAutoMakeup`: the solve renders
 * both kernels several times, so it runs on the worker's capped window; the
 * ceiling is the guarantee and is a claim about the whole source, so it comes
 * from `regionPeakDb` — the window's peak would hold a louder passage the
 * window never saw down to it.
 *
 * @param {{ peaksDb: number, bodyDb: number, cornerHz?: number|null, bodyGuess?: number, bodyBench?: object }} targets
 */
export function computeVoxPressorSolve(segments, start, end, targets, sampleRate, channels) {
  return measureInWorker(
    'voxPressorSolve', segments, start, end, targets, sampleRate, channels,
  ).then(({ type, ...d }) => {
    const peakDb = regionPeakDb(segments, start, end, sampleRate, channels)
    const ceilingDb = Number.isFinite(peakDb) ? peakDb : null
    return {
      ...d,
      peaksCeilingDb: d.peaksOn ? ceilingDb : null,
      bodyCeilingDb: d.bodyOn ? ceilingDb : null,
    }
  })
}

/**
 * VoxPressor's per-stage peak restores, measured EXACTLY over the whole region
 * — for a region longer than the solve's analysis window. Resolves the solved
 * params with the restores, ceilings and Body offset corrected. See
 * `measureVoxPressorExact`.
 */
export function computeVoxPressorExact(segments, start, end, solved, sampleRate, channels) {
  const sourcePeakDb = regionPeakDb(segments, start, end, sampleRate, channels)
  return measureWholeRegionInWorker(
    'voxPressorExact', segments, start, end, { solved, sourcePeakDb }, sampleRate, channels,
  ).then(d => d.solved)
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
 * Measure this speaker's pitch for a region, for zone placement.
 *
 * Goes through measureInWorker like the makeup measurements, so it inherits
 * their 30 s centred cap. That is right for this quantity and wrong for very
 * few: pitch is a property of the speaker, not of the passage, so a
 * representative half-minute answers the question as well as ten minutes would
 * and costs a bounded amount of time.
 *
 * ⚠ Resolves null when the region holds no pitched material. Not an error — the
 * caller must leave the zones alone rather than placing them from a fallback.
 */
export function computeVoiceProfile(segments, start, end, sampleRate, channels) {
  return measureInWorker('voiceProfile', segments, start, end, {}, sampleRate, channels)
    .then(d => d.profile ?? null)
}

/** The whole worklet chain's delay: the plugin's own plus every stage's. */
function chainLatency(latencySamples, stages) {
  return Math.max(0, Math.round(
    latencySamples + stages.reduce((sum, st) => sum + (st.latencySamples ?? 0), 0),
  ))
}

/**
 * The pre-roll a render actually gets: what the plugin asks for, clamped to the
 * audio the timeline has before the region — see PRE-ROLL in applyWorkletRegion.
 */
function regionPreRoll(preRollSamples, start, sampleRate) {
  const wanted = Math.max(0, Math.round(preRollSamples))
  return Math.min(wanted, Math.max(0, Math.floor(start * sampleRate)))
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
  { ensureWorklet, processorName, kernelParams, latencySamples = 0, preRollSamples = 0, preStages = [], postStages = [] },
) {
  const duration = end - start
  const numSamples = Math.ceil(duration * sampleRate)
  // Pre- and post-stages are worklets chained AHEAD of / AFTER the main one,
  // each with its own latency; the whole chain's delay is what the render has
  // to trim. Only the HF Softener's Reso post-stage uses this today — every
  // other caller passes none and renders exactly as before.
  const stages = [...preStages, ...postStages]
  const latency = chainLatency(latencySamples, stages)

  // ── PRE-ROLL ─────────────────────────────────────────────────────────────
  //
  // ⚠ WITHOUT THIS, A STAGE WITH ENVELOPE STATE DOES NOT PRODUCE WHAT THE
  // PREVIEW PRODUCED, and the gap is not small. The preview worklet has been
  // running over everything the user played; this render starts COLD at the
  // region's first sample. Measured on Tube Saturation, preview settled against
  // a cold apply, energy over the first 0.5 s of the region: -0.36 dB at the
  // shipped default and -2.06 dB with its slower trackers engaged. That second
  // figure sits inside the range tapeCharacter records for the same defect the
  // last time it shipped ("preview came out 1.5-2.3 dB more softened").
  //
  // Worse than a level offset: a stage that makes a DECISION from tracked
  // state can decide differently. Tube Saturation's skew tracker settles to
  // direction -0.62 on positive-leaning material but reads +1.00 before its 3 s
  // evidence gate, so a selection shorter than that had its asymmetry leaning
  // the wrong way — worth up to 7.9 dB of extra distortion by that module's own
  // measurement.
  //
  // ⚠ CLAMPED TO WHAT THE TIMELINE ACTUALLY HAS, and that is not a detail.
  // renderRegionToBuffer zero-fills before the start of the timeline, and
  // priming an RmsFollower with four seconds of digital silence is WORSE than
  // starting cold: its warmup would complete on the silence and the exponential
  // average would then have to climb from zero, which is the exact failure the
  // warmup exists to prevent. A region at t=0 therefore gets no pre-roll and
  // behaves exactly as it did before.
  //
  // ⚠ OPT-IN, ONE STAGE AT A TIME. Every caller of this function has envelope
  // state and the same bug; turning it on for all of them at once would change
  // the output of five shipped plugins in one commit. Four ask for it, each
  // after its own measurement: Tube Saturation (4 s), OptoSmooth (2 s),
  // Scheps (2 s) and the HF Softener (2 s, for its lisp guard’s 500 ms hold) — see the
  // note beside each call site for what its number buys. The rest keep today's behaviour until each is measured on its own.
  //
  // Two of those measurements say pre-roll is not the answer, and they are the
  // reason this is not a flag to switch on everywhere. FET Punch's makeup
  // tracker is a running MAXIMUM, so no length of pre-roll converges it — only
  // a bounded reference would. ResoTame's error is the STFT grid phase,
  // (regionStart - preRoll) % hop, which the apply path cannot know; a pre-roll
  // that happens to land hop-aligned looks exact and is not.
  const preRoll = regionPreRoll(preRollSamples, start, sampleRate)
  const renderSamples = preRoll + numSamples + latency

  // Pull `latency` extra samples of real audio from past the region where the
  // timeline has them, so the tail is reconstructed from context rather than
  // from silence. renderRegionToBuffer zero-fills beyond the end of the
  // timeline, which is exactly what we want there.
  const channelData = renderRegionToBuffer(
    segments, start - preRoll / sampleRate, end + latency / sampleRate, sampleRate, channels,
  )

  const offlineCtx = new OfflineAudioContext(channels, renderSamples, sampleRate)
  await ensureWorklet(offlineCtx)
  for (const st of stages) await st.ensureWorklet(offlineCtx)

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

  const stageNode = st => new AudioWorkletNode(offlineCtx, st.processorName, {
    channelCount: channels,
    channelCountMode: 'explicit',
    outputChannelCount: [channels],
    processorOptions: { params: st.kernelParams, ...(st.processorOptions ?? {}) },
  })
  let upstream = source
  for (const st of preStages) {
    const pre = stageNode(st)
    upstream.connect(pre)
    upstream = pre
  }
  upstream.connect(node)
  upstream = node
  for (const st of postStages) {
    const post = stageNode(st)
    upstream.connect(post)
    upstream = post
  }
  upstream.connect(offlineCtx.destination)
  source.start(0)

  const rendered = await offlineCtx.startRendering()
  // The pre-roll is discarded along with the latency: both are context the
  // kernel needed to see and neither belongs on the timeline.
  const head = preRoll + latency
  if (head === 0) return rendered

  // Drop the leading `head` samples so output sample 0 corresponds to the
  // region's first input sample, and hand back a buffer of exactly the region's
  // length — that is what replaceRegion expects to splice in.
  const trimmed = offlineCtx.createBuffer(channels, numSamples, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    trimmed.copyToChannel(
      rendered.getChannelData(ch).subarray(head, head + numSamples),
      ch,
    )
  }
  return trimmed
}

/**
 * Apply a region: in parallel chunks when the plugin opts in (`chunk`) and the
 * region is long enough to split, otherwise — and on any error — through the
 * one-thread worklet render.
 *
 * `chunk` is { renderer, grid }: the kernel's name in chunkRender.js and the
 * grid each chunk's start must sit on (see chunkedApply.js). The run-in is
 * CHUNK_RUN_IN_S for every plugin. Every post-stage must name a `renderer`
 * too, or the region renders on one thread.
 */
async function applyRegion(segments, start, end, sampleRate, channels, opts) {
  const { chunk, preStages = [], postStages = [] } = opts
  const chunkable = chunk && preStages.length === 0 && postStages.every(st => st.renderer)
  if (chunkable) {
    const numSamples = Math.ceil((end - start) * sampleRate)
    const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 1
    const count = chunkCount(numSamples, sampleRate, cores)
    if (count > 1) {
      try {
        return await applyChunkedRegion(segments, start, end, sampleRate, channels, opts, count)
      } catch (err) {
        // Never lose an apply to the fast path: fall back to the one-thread render.
        console.error(`${opts.processorName}: parallel apply failed, rendering on one thread:`, err)
      }
    }
  }
  return applyWorkletRegion(segments, start, end, sampleRate, channels, opts)
}

/**
 * A region in parallel chunks (chunkedApply.js): the same input the one-thread
 * render would see, with the same pre-roll and the same latency, cut on the
 * plugin's grid, each chunk rendered with a run-in of the audio before it in a
 * worker of its own, then laid end to end. What each plugin stitches to is
 * pinned in test/dsp/chunkedApply.test.js.
 */
async function applyChunkedRegion(segments, start, end, sampleRate, channels, opts, count) {
  const { kernelParams, latencySamples = 0, preRollSamples = 0, postStages = [], chunk } = opts
  const numSamples = Math.ceil((end - start) * sampleRate)
  const latency = chainLatency(latencySamples, postStages)
  const preRoll = regionPreRoll(preRollSamples, start, sampleRate)
  const stages = [
    { renderer: chunk.renderer, kernelParams, options: opts.processorOptions },
    ...postStages.map(st => ({ renderer: st.renderer, kernelParams: st.kernelParams, options: st.processorOptions })),
  ]
  const input = renderRegionToBuffer(segments, start - preRoll / sampleRate, end + latency / sampleRate, sampleRate, channels)
  const plan = planChunks(numSamples, preRoll, latency, sampleRate, count, { grid: chunk.grid })
  const workers = []
  try {
    const parts = await Promise.all(plan.map((c) => {
      const data = input.map((src) => {
        const x = new Float32Array(c.to - c.from)
        x.set(src.subarray(c.from, Math.min(c.to, src.length)))
        return x
      })
      return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../workers/processWorker.js', import.meta.url), { type: 'module' })
        workers.push(worker)
        worker.onmessage = (e) => {
          if (e.data?.type === 'done') resolve(e.data.channelData)
          else reject(new Error(e.data?.message ?? 'chunk render failed'))
        }
        worker.onerror = reject
        worker.postMessage(
          { __id: 0, type: 'renderChunk', channelData: data, sampleRate, params: { stages, latency, skip: c.skip, length: c.length } },
          data.map(d => d.buffer),
        )
      })
    }))
    const out = new AudioBuffer({ length: numSamples, numberOfChannels: channels, sampleRate })
    for (let ch = 0; ch < channels; ch++) {
      const y = new Float32Array(numSamples)
      plan.forEach((c, k) => y.set(parts[k][ch], c.start))
      out.copyToChannel(y, ch)
    }
    return out
  } finally {
    for (const w of workers) w.terminate()
  }
}

/**
 * Apply OptoSmooth (LA-2A) compression to a region.
 *
 * ⚠ THE LATENCY IS PER-PATCH, NOT A CONSTANT — lookahead adds its own delay on
 * top of the oversampler's 50 samples, and at the 20 ms ceiling that is 882
 * more. Trimming the constant instead would splice the region in that far late
 * and drop that much of its tail, at both boundaries. Same shape as the soft
 * clipper's limiter; see the note on `applySoftClipperRegion`.
 */
export function applyLA2ARegion(segments, start, end, params, sampleRate, channels) {
  const merged = { ...LA2A_DEFAULTS, ...params }
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureLA2AWorklet,
    processorName: 'la2a-processor',
    kernelParams: toKernelParams(merged),
    latencySamples: la2aPatchLatencySamples(merged, sampleRate),
    // Bit-exact against a settled preview at this length — see LA2A_PREROLL_S
    // for the measurements and for why nothing in this kernel latches.
    preRollSamples: Math.round(LA2A_PREROLL_S * sampleRate),
    // Nothing latches, so a chunk's state is a function of its run-in alone.
    chunk: { renderer: 'la2a' },
  })
}

/**
 * Apply FET Punch (1176) compression to a region.
 *
 * Resolves `{ buffer, trimDb }` rather than a bare buffer: the peak restore is
 * a per-region measurement the panel reports, so it has to come back out.
 *
 * ⚠ THE RESTORE IS MEASURED ON THIS RENDER, WHICH IS WHY IT LIVES HERE AND NOT
 * IN THE SOLVE. The makeup is solved on a capped window; this buffer is the
 * whole region. See `peakRestoreTrimDb` for why a window-derived trim would
 * push a late loud passage past the source peak, and for the preview/apply
 * divergence this deliberately accepts.
 *
 * ⚠ AFTER THE PRE-ROLL AND LATENCY ARE TRIMMED, necessarily — a peak sitting in
 * the discarded head is not part of what lands on the timeline, and measuring
 * before the trim would size the restore from audio the user never gets.
 */
export async function applyFET1176Region(segments, start, end, params, sampleRate, channels) {
  const kernelParams = toFET1176KernelParams({ ...FET1176_DEFAULTS, ...params })
  const buffer = await applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureFET1176Worklet,
    processorName: 'fet1176-processor',
    kernelParams,
    latencySamples: FET1176_LATENCY_SAMPLES,
    // Convergent at this length once the tail came off — see FET1176_PREROLL_S.
    preRollSamples: Math.round(FET1176_PREROLL_S * sampleRate),
    // ⚠ The peak restore below must see the STITCHED region, never a chunk:
    // a chunk's peak is not the region's, so it runs after this resolves.
    chunk: { renderer: 'fet1176' },
  })
  const channelData = []
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) channelData.push(buffer.getChannelData(ch))
  // getChannelData hands back the buffer's own storage, so this scales in place.
  const trimDb = restorePeakToCeiling(channelData, kernelParams.ceilingDb)
  return { buffer, trimDb }
}

/**
 * Apply the Adaptive Soft Clipper to a region.
 *
 * ⚠ THE LATENCY IS PER-PATCH, NOT A CONSTANT. The limiter adds its lookahead
 * only while engaged, and it ships engaged — trimming the oversampler's 50
 * samples when the stage actually delays 226 (at 44.1 kHz) shifts the region 176
 * samples late and drops that much of its tail.
 */
export function applySoftClipperRegion(segments, start, end, params, sampleRate, channels) {
  const kernelParams = toSoftClipperKernelParams({ ...SOFT_CLIPPER_DEFAULTS, ...params })
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureSoftClipperWorklet,
    processorName: 'soft-clipper-processor',
    kernelParams,
    latencySamples: softClipperLatencySamples(kernelParams, sampleRate),
  })
}

/**
 * The HF Softener's automatic Air for a region: the chain's top-end loss and
 * the Air it asks for, over the usual capped analysis window. Resolves
 * `{ lossDb, airDb }`.
 */
export function measureHFSoftenerAutoAir(segments, start, end, params, sampleRate, channels) {
  const merged = { ...HF_SOFTENER_DEFAULTS, ...params }
  return measureInWorker('deEsserAutoAir', segments, start, end, {
    kernelParams: toHFSoftenerKernelParams(merged),
    resoParams: resoOn(merged) ? resoKernelParams(merged) : null,
    resoFrameSize: HF_RESO_FRAME_SIZE,
  }, sampleRate, channels)
}

/**
 * PHAT*SS's Warmth readout for a region (see phatassWarmthReadout.js).
 * Selections up to READOUT_WHOLE_MAX_S are rendered whole, bands and peak.
 * Longer ones render READOUT_BLOCKS sampled blocks for the bands, and the peak
 * is the guard's bound — the selection's own peak, scanned, not rendered —
 * whenever the guard has a ceiling (null otherwise). Resolves
 * `{ bandsDb, peakDb, inputPeakDb }`.
 */
export function measurePhatassWarmthBands(segments, start, end, params, sampleRate, channels) {
  const { warmthLayers, warmthGuard } = toPhatassKernelParams({ ...PHATASS_DEFAULTS, ...params })
  if (!(end - start > READOUT_WHOLE_MAX_S)) {
    return measureWholeRegionInWorker('phatassWarmthReadout', segments, start, end, {
      layers: warmthLayers, guard: warmthGuard, bands: true, peak: true,
    }, sampleRate, channels).then(d => ({ bandsDb: d.bandsDb, peakDb: d.peakDb, inputPeakDb: d.inputPeakDb }))
  }
  const n = Math.floor((end - start) * sampleRate)
  const blocks = readoutBlocks(n, sampleRate).map(([a, b, skip]) => ({
    channelData: renderRegionToBuffer(segments, start + a / sampleRate, start + b / sampleRate, sampleRate, channels),
    skip,
  }))
  const bounded = warmthGuard.on && Number.isFinite(warmthGuard.ceilingDb)
  const inputPeakDb = bounded ? regionPeakDb(segments, start, end, sampleRate, channels) : null
  return new Promise((resolve, reject) => {
    const id = ++measureSeq
    measurePending.set(id, { resolve, reject })
    getMeasureWorker().postMessage(
      {
        __id: id, type: 'phatassWarmthReadout', channelData: [], sampleRate,
        params: { layers: warmthLayers, guard: warmthGuard, blocks },
      },
      blocks.flatMap(b => b.channelData.map(c => c.buffer)),
    )
  }).then(d => ({ bandsDb: d.bandsDb, peakDb: inputPeakDb, inputPeakDb }))
}

/**
 * A measurement that runs on a worker of its own, one pass per OWNER at a time:
 * a newer call from the same owner terminates the older one — a knob turn must
 * never queue behind a stale whole-chapter render — and a superseded call
 * rejects with `err.cancelled = true`.
 *
 * ⚠ PER OWNER, NOT PER PROCESS. The owner is the plugin copy asking (its
 * EffectChain id): with one pass for the whole app, two copies of PHAT*SS — the
 * solo one and one in the chain, or two in the chain — cancelled each other's
 * measurements on every knob turn and neither makeup ever settled.
 */
function ownedWorkerJob(type, resultKeys, failMessage) {
  const jobs = new Map() // owner → { worker, reject }

  function cancel(owner = 'default') {
    const job = jobs.get(owner)
    if (!job) return
    jobs.delete(owner)
    job.worker.terminate()
    const err = new Error('superseded')
    err.cancelled = true
    job.reject(err)
  }

  function run(segments, start, end, params, sampleRate, channels, { exact = true, owner = 'default' } = {}) {
    cancel(owner)
    return new Promise((resolve, reject) => {
      // Rendered before the worker exists: if it throws, nothing is left
      // running or registered for this owner.
      const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
      const worker = new Worker(new URL('../workers/processWorker.js', import.meta.url), { type: 'module' })
      jobs.set(owner, { worker, reject })
      const finish = () => {
        worker.terminate()
        if (jobs.get(owner)?.worker === worker) jobs.delete(owner)
      }
      worker.onmessage = (e) => {
        finish()
        if (e.data?.type === 'done') resolve(Object.fromEntries(resultKeys.map(k => [k, e.data[k]])))
        else reject(new Error(e.data?.message ?? failMessage))
      }
      worker.onerror = (err) => {
        finish()
        reject(err)
      }
      worker.postMessage(
        // A plain copy: the panel's params are reactive, and a proxied array
        // (warmthRefPeaksDb) cannot be structured-cloned into a worker.
        { __id: 0, type, channelData, sampleRate, params: JSON.parse(JSON.stringify(params)), exact },
        channelData.map(c => c.buffer),
      )
    })
  }

  return { run, cancel }
}

/**
 * TAPE's automatic makeup for a region: what TAPE takes off the WHOLE
 * region's peak (see phatassTapeMakeup.js), on its own worker per owner (see
 * ownedWorkerJob). `exact: false` is the fast bounded search for live preview;
 * apply leaves it exact. Resolves `{ makeupDb, peakDb, inputPeakDb }`.
 */
const tapeMakeupJob = ownedWorkerJob('phatassTapeMakeup', ['makeupDb', 'peakDb', 'inputPeakDb'], 'tape makeup failed')
export const measurePhatassTapeMakeup = tapeMakeupJob.run
/** Terminate `owner`'s in-flight TAPE makeup pass, if any; it rejects with `err.cancelled`. */
export const cancelPhatassTapeMakeup = tapeMakeupJob.cancel

/**
 * The bench's output trim for a region (see phatassOutputMakeup.js): a render
 * of the whole chain, on its own worker per owner. `exact: false` is the capped
 * preview measurement. Resolves `{ makeupDb, outPeakDb, inputPeakDb }`.
 */
const outputMakeupJob = ownedWorkerJob('phatassOutputMakeup', ['makeupDb', 'outPeakDb', 'inputPeakDb'], 'output makeup failed')
export const measurePhatassOutputMakeup = outputMakeupJob.run
/** Terminate `owner`'s in-flight output-trim pass, if any; it rejects with `err.cancelled`. */
export const cancelPhatassOutputMakeup = outputMakeupJob.cancel

/** Apply Air Band to a region. */
export function applyAirBandRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureAirBandWorklet,
    processorName: 'air-band-processor',
    kernelParams: toAirBandKernelParams({ ...AIR_BAND_DEFAULTS, ...params }),
  })
}

/**
 * Apply Saturation Bench to a region. Its latency is constant (every layer
 * slot delays, on or off) and is trimmed; the pre-roll settles the voicing
 * detector and the band filters.
 */
export function applySaturationBenchRegion(segments, start, end, params, sampleRate, channels) {
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureSaturationBenchWorklet,
    processorName: 'saturation-bench-processor',
    kernelParams: toSaturationBenchKernelParams({ ...SATURATION_BENCH_DEFAULTS, ...params }),
    latencySamples: SAT_BENCH_LATENCY_SAMPLES,
    preRollSamples: Math.round(SAT_BENCH_PREROLL_S * sampleRate),
    chunk: { renderer: 'saturationBench' },
  })
}

/**
 * Apply the HF Softener to a region. Zero latency; the pre-roll lets the
 * envelopes settle on real context so the region starts where a playing
 * preview would be — see HF_SOFTENER_PREROLL_S.
 */
export function applyHFSoftenerRegion(segments, start, end, params, sampleRate, channels) {
  const merged = { ...HF_SOFTENER_DEFAULTS, ...params }
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureHFSoftenerWorklet,
    processorName: 'hf-softener-processor',
    kernelParams: toHFSoftenerKernelParams(merged),
    preRollSamples: Math.round(HF_SOFTENER_PREROLL_S * sampleRate),
    // The softener is zero-latency, so Reso's STFT is anchored where the render
    // starts and its hop (128 at a 512 frame) is the grid; Soften has no grid
    // of its own. Each post-stage names its kernel for the chunk render.
    chunk: {
      renderer: 'hfSoftener',
      grid: resoOn(merged) ? resonanceHopSamples(HF_RESO_FRAME_SIZE) : undefined,
    },
    // The Reso knob above 0: a band-limited ResoTame AFTER the softener — see
    // deEsserResoStage.js. Its 512-sample latency is trimmed with the rest.
    // ⚠ Like ResoTame itself, its STFT grid phase at the region start cannot
    // match a running preview, so with RESO on apply is close to the preview
    // rather than sample-identical.
    postStages: [
      ...(resoOn(merged) ? [{
        ensureWorklet: ensureResonanceWorklet,
        processorName: 'resonance-processor',
        renderer: 'resonance',
        kernelParams: resoKernelParams(merged),
        processorOptions: { frameSize: HF_RESO_FRAME_SIZE },
        latencySamples: HF_RESO_LATENCY_SAMPLES,
      }] : []),
      // The Soften knob above 0: the HF Limiter's kernel with the shelf out and
      // its Transient on a 500 Hz band — see deEsserSoftenStage.js. Constant
      // latency (the shelf's 3 ms), trimmed with the rest; no STFT, so it stays
      // sample-identical to the preview.
      ...(softenOn(merged) ? [{
        ensureWorklet: ensureHFLimiterWorklet,
        processorName: 'hf-limiter-processor',
        renderer: 'hfLimiter',
        kernelParams: softenStageKernelParams(merged),
        latencySamples: softenLatencySamples(sampleRate),
      }] : []),
    ],
  })
}

/**
 * Apply the HF Limiter to a region. Constant latency per sample rate, and a
 * pre-roll so the release starts where a playing preview's would be.
 */
export function applyHFLimiterRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureHFLimiterWorklet,
    processorName: 'hf-limiter-processor',
    kernelParams: toHFLimiterKernelParams({ ...HF_LIMITER_DEFAULTS, ...params }),
    latencySamples: hfLimiterLatencySamples(sampleRate),
    preRollSamples: Math.round(HF_LIMITER_PREROLL_S * sampleRate),
  })
}

/**
 * Apply the Plosive Tamer to a region. Constant latency (the lookahead), and a
 * pre-roll so the held voice level the closure test reads starts where a
 * playing preview's would be.
 */
export function applyPlosiveRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensurePlosiveWorklet,
    processorName: 'plosive-processor',
    kernelParams: toPlosiveKernelParams({ ...PLOSIVE_DEFAULTS, ...params }),
    latencySamples: plosiveLatencySamples(sampleRate),
    preRollSamples: Math.round(PLOSIVE_PREROLL_S * sampleRate),
  })
}

/**
 * Apply PHAT*SS to a region. Constant latency per sample rate (every stage is
 * a delay of its own length when idle), and a pre-roll so the shelf's release
 * starts where a playing preview's would be.
 */
export function applyPhatassRegion(segments, start, end, params, sampleRate, channels) {
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensurePhatassWorklet,
    processorName: 'phatass-processor',
    kernelParams: toPhatassKernelParams({ ...PHATASS_DEFAULTS, ...params }),
    latencySamples: phatassLatencySamples(sampleRate),
    preRollSamples: Math.round(PHATASS_PREROLL_S * sampleRate),
    chunk: { renderer: 'phatass' },
  })
}

/** Apply Scheps Parallel to a region. */
export function applySchepsRegion(segments, start, end, params, sampleRate, channels) {
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureSchepsWorklet,
    processorName: 'scheps-processor',
    kernelParams: toSchepsKernelParams({ ...SCHEPS_DEFAULTS, ...params }),
    latencySamples: SCHEPS_LATENCY_SAMPLES,
    // Inherits the LA-2A kernel, so it inherits its convergence — see
    // SCHEPS_PREROLL_S. Also bit-exact at this length.
    preRollSamples: Math.round(SCHEPS_PREROLL_S * sampleRate),
    chunk: { renderer: 'scheps' },
  })
}

/**
 * Apply VoxPressor to a region. One-thread render for now: the plugin is not
 * opted into chunked apply until its seams are measured (chunkedApply.js).
 */
export function applyVoxPressorRegion(segments, start, end, params, sampleRate, channels) {
  const kernelParams = toVoxKernelParams({ ...VOX_DEFAULTS, ...params, listen: 'off' })
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureVoxPressorWorklet,
    processorName: 'vox-pressor-processor',
    kernelParams,
    latencySamples: voxLatencySamples(kernelParams, sampleRate),
    // Both kernels converge by 2 s (LA2A_PREROLL_S, FET1176_PREROLL_S); the
    // 1176's makeup tracker latches but VoxPressor never reads it.
    preRollSamples: Math.round(Math.max(LA2A_PREROLL_S, FET1176_PREROLL_S) * sampleRate),
  })
}

/** Apply Vocal Saturation to a region. */
export function applyVocalSatRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureVocalSatWorklet,
    processorName: 'vocal-sat-processor',
    kernelParams: toVocalSatKernelParams({ ...VOCAL_SAT_DEFAULTS, ...params }),
    latencySamples: VOCAL_SAT_LATENCY_SAMPLES,
    // ⚠ THE ONLY CALLER ASKING FOR THIS SO FAR. Tube Saturation carries the
    // slowest trackers in the app — a 3 s skew evidence gate and a 1.5 s level
    // follower — so a cold start showed up as a 2 dB error over the opening of
    // a region. See VOCAL_SAT_PREROLL_S for the measurements and for why it
    // narrows the gap rather than closing it.
    preRollSamples: Math.round(VOCAL_SAT_PREROLL_S * sampleRate),
  })
}

/** Apply the Inflator to a region. */
export function applyInflatorRegion(segments, start, end, params, sampleRate, channels) {
  return applyWorkletRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureInflatorWorklet,
    processorName: 'inflator-processor',
    kernelParams: toInflatorKernelParams({ ...INFLATOR_DEFAULTS, ...params }),
    latencySamples: INFLATOR_LATENCY_SAMPLES,
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
 * Apply a solved auto-leveler curve to a region and return the new buffer.
 *
 * The curve is expressed over the ANALYSED region, which is usually larger than
 * what is being written: analysing a chapter and applying one chapter is the
 * common case, but narrowing to a paragraph afterwards is allowed and every
 * clip inside it was already measured. `offsetSamples` is where this region
 * starts within that one, so the gains stay attached to the audio they were
 * computed from rather than sliding to the head of the selection.
 */
export function applyAutoLevelRegion(
  segments, start, end, gainSegments, analysisStartSec, sampleRate, channels,
) {
  const channelData = renderRegionToBuffer(segments, start, end, sampleRate, channels)
  const numSamples = channelData[0].length
  const offsetSamples = Math.round((start - analysisStartSec) * sampleRate)

  const levelled = applyGainSegments(channelData, gainSegments, numSamples, offsetSamples)

  const ctx = new OfflineAudioContext(channels, numSamples, sampleRate)
  const out = ctx.createBuffer(channels, numSamples, sampleRate)
  for (let ch = 0; ch < channels; ch++) {
    out.getChannelData(ch).set(levelled[ch])
  }
  return out
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
  return applyRegion(segments, start, end, sampleRate, channels, {
    ensureWorklet: ensureResonanceWorklet,
    processorName: 'resonance-processor',
    kernelParams: toResonanceKernelParams({ ...RESONANCE_DEFAULTS, ...params }),
    latencySamples: RESONANCE_LATENCY_SAMPLES,
    // ⚠ NO PRE-ROLL, DELIBERATELY — see the note on StftProcessor's use in
    // resonanceProcessor.js. This stage's disagreement is a frame-PHASE error,
    // not a convergence one, and a pre-roll cannot fix it.
    //
    // ⚠ BUT THE CHUNKS NEED THE HOP GRID. Within one apply the phase IS known —
    // it is the render's own start — so a chunk cut on the hop grid relative to
    // it agrees with the continuous render; cut on the 128 grid alone it read
    // −20 dB re the peak for the whole chunk.
    chunk: { renderer: 'resonance', grid: resonanceHopSamples(RESONANCE_FRAME_SIZE) },
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
