/**
 * Spot noise reduction — the Noise Reduction plugin's server half
 * (`POST /api/spot/noise_reduction`).
 *
 * Runs the mastering chain's own denoisers on a selection: DeepFilterNet3,
 * RNNoise, or both in the ACX preset's order (DF3 → RNNoise). The params and
 * their validation are shared with the browser (src/audio/noiseReductionParams.js).
 *
 * ⚠ THIS IS NOT THE `noiseReduce` STAGE AND MUST NOT CALL IT. The stage is
 * written for the chain: it picks DF3's cap from a noise-floor tier, may skip
 * itself outright on a clean file, and finishes with a peak re-normalisation
 * that assumes peakNormalize ran first. A spot edit wants none of that — the
 * user set the cap, asked for the pass, and is splicing the result back into a
 * file whose level around the selection is fixed. So this calls the same model
 * wrappers the stage calls (noiseReduce.js) and leaves the level alone: the
 * output is exactly what the model returned, length-matched to the input.
 *
 * CHANNELS ARE PROCESSED ONE AT A TIME. RNNoise is mono-only (its script mixes
 * a stereo input down), and a spot edit must hand back the channel count it was
 * given or the splice fails. Each channel is denoised as its own mono file; the
 * RNNoise consonant guard reads ONE Silero mask from the mono mixdown, since
 * speech is a property of the recording rather than of either side.
 *
 * SAMPLE RATE. The models run at 44.1 kHz in (the pipeline's internal rate) and
 * the result is resampled back to whatever rate was uploaded, so the browser
 * splices it at its own rate with no conversion of its own.
 */

import { readWavAllChannels, readWavHeader } from './wavReader.js'
import { writeWavChannels } from './wavWriter.js'
import { decodeToFloat32, mixdownToMono, tempPath, removeTmp } from '../lib/ffmpeg.js'
import { runFfmpeg } from '../lib/exec-ffmpeg.js'
import { applyNoiseReduction, runRnnoise } from './noiseReduce.js'
import { analyzeFrames } from './frameAnalysis.js'
import { parseServerParams, usesDf3, usesRnnoise } from '../../src/audio/noiseReductionParams.js'

const INTERNAL_SAMPLE_RATE = 44100

/**
 * The consonant guard's settings — the ACX Audiobook preset's second NR pass
 * (src/audio/presets.js), copied rather than imported because that preset's
 * config is the chain's to re-tune and this is a user-facing switch whose
 * meaning should not move with it.
 */
export const SPOT_RNNOISE_VAD_GATE = {
  enabled: true,
  rnnoiseThreshold: 0.7,
  crossfadeMs: 1.0,
  hangoverFrames: 2,
}

/** Copy `src` into exactly `n` samples: trimmed, or zero-padded at the end. */
export function fitLength(src, n) {
  if (src.length === n) return src
  const out = new Float32Array(n)
  out.set(src.length > n ? src.subarray(0, n) : src)
  return out
}

/**
 * @param {string} inputPath   the upload (WAV, any rate, any channel count)
 * @param {string} outputPath  32-bit float WAV at the upload's rate and width
 * @param {object} rawParams   request params (validated here)
 * @param {object} [deps]      model runners — injectable so the plumbing can be
 *                             tested without Python
 * @returns {Promise<object>}  a summary for the log
 */
export async function runSpotNoiseReduction(inputPath, outputPath, rawParams, deps = {}) {
  const {
    df3 = applyNoiseReduction,
    rnnoise = runRnnoise,
    vadFrames = defaultVadFrames,
  } = deps
  const params = parseServerParams(rawParams)

  let sourceRate = INTERNAL_SAMPLE_RATE
  try {
    sourceRate = (await readWavHeader(inputPath)).sampleRate || INTERNAL_SAMPLE_RATE
  } catch {
    // Not a WAV the header reader understands — ffmpeg decodes it regardless,
    // and the result goes back at the internal rate.
  }

  const tmp = []
  const temp = (ext = '.wav') => { const p = tempPath(ext); tmp.push(p); return p }

  try {
    const decodedPath = temp()
    await decodeToFloat32(inputPath, decodedPath)
    const { channels } = await readWavAllChannels(decodedPath)
    if (!channels.length || channels[0].length === 0) throw new Error('No audio in the upload')
    const numSamples = channels[0].length

    // One speech mask for every channel, only when the guard needs one.
    let sileroFrames = null
    if (usesRnnoise(params.engine) && params.protectConsonants) {
      let monoPath = decodedPath
      if (channels.length > 1) {
        monoPath = temp()
        await mixdownToMono(decodedPath, monoPath)
      }
      sileroFrames = await vadFrames(monoPath)
    }

    const outChannels = []
    for (const channel of channels) {
      let current = temp()
      await writeWavChannels([channel], INTERNAL_SAMPLE_RATE, current)

      if (usesDf3(params.engine)) {
        const next = temp()
        await df3(current, next, { attenLimDb: params.df3AttenLimDb })
        current = next
      }
      if (usesRnnoise(params.engine)) {
        const next = temp()
        await rnnoise(current, next, {
          sileroFrames,
          vadGate: sileroFrames ? SPOT_RNNOISE_VAD_GATE : null,
        })
        current = next
      }

      // Both wrappers write 44.1 kHz float; a stereo-shaped result (none is
      // expected) is read for its first channel only.
      const result = await readWavAllChannels(current)
      outChannels.push(fitLength(result.channels[0], numSamples))
    }

    if (sourceRate === INTERNAL_SAMPLE_RATE) {
      await writeWavChannels(outChannels, INTERNAL_SAMPLE_RATE, outputPath)
    } else {
      const internalPath = temp()
      await writeWavChannels(outChannels, INTERNAL_SAMPLE_RATE, internalPath)
      await runFfmpeg([
        '-i', internalPath,
        '-ar', String(sourceRate),
        '-acodec', 'pcm_f32le',
        '-f', 'wav',
        outputPath,
      ])
    }

    return {
      engine: params.engine,
      df3AttenLimDb: params.df3AttenLimDb,
      protectConsonants: !!sileroFrames,
      channels: channels.length,
      durationS: numSamples / INTERNAL_SAMPLE_RATE,
    }
  } finally {
    await Promise.all(tmp.map(removeTmp))
  }
}

async function defaultVadFrames(monoPath) {
  const result = await analyzeFrames(monoPath)
  return result.frames ?? null
}
