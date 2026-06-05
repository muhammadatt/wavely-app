/**
 * Hum Detection and Conditional EQ Stage
 *
 * Analyzes audio for the presence of mains hum (60 Hz US / 50 Hz EU
 * fundamental and harmonics) using FFT-based spectral analysis. When hum is
 * detected above a configurable threshold, narrow parametric notch filters are
 * applied via FFmpeg's equalizer filter. If no hum is detected the file passes
 * through unmodified.
 *
 * Module interface:
 *   humEQ(inputPath, outputPath, options) → Promise<HumEQResult>
 *   analyzeHum(inputPath, options)        → Promise<HumAnalysisResult>
 *
 * HumEQResult {
 *   triggered: boolean,
 *   flaggedHarmonics: number[],   // Hz values that exceeded threshold
 *   notchesApplied: number[],     // Hz values where notches were applied ([] if not triggered)
 *   detectionDetail: HarmonicDetail[],
 *   ffmpegFilter: string | null,  // the equalizer filter string, or null
 *   inputPath: string,
 *   outputPath: string | null,
 * }
 *
 * HarmonicDetail {
 *   frequency: number,   // Hz
 *   peakDb: number,      // peak magnitude in ±2 Hz window
 *   floorDb: number,     // median magnitude in analysis window (excluding notch band)
 *   deltaDb: number,     // peakDb - floorDb
 *   flagged: boolean,
 * }
 */

import { spawn }     from 'child_process'
import { copyFile }  from 'fs/promises'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import { runFfmpeg } from '../lib/exec-ffmpeg.js'

const FFMPEG_PATH = ffmpegInstaller.path

// Internal processing constants
const SAMPLE_RATE          = 44100
const FFT_SIZE             = 524288   // 2^19 — ~0.084 Hz/bin at 44.1 kHz
const MAX_ANALYSIS_SECONDS = 10       // hum is stationary; first 10 s is sufficient

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Detect and conditionally apply hum correction.
 *
 * When triggered, notch filters are written to outputPath via FFmpeg.
 * When not triggered (and not in dryRun mode), the input is copied to outputPath.
 *
 * @param {string}  inputPath
 * @param {string|null}  outputPath  — ignored when dryRun is true
 * @param {object}  options
 * @returns {Promise<HumEQResult>}
 */
export async function humEQ(inputPath, outputPath, options = {}) {
  const {
    dryRun     = false,
    notchDepth = 18,
    notchQ     = 30,
    ...analysisOptions
  } = options

  const detection = await analyzeHum(inputPath, { notchDepth, notchQ, ...analysisOptions })
  const { triggered, flaggedHarmonics, detectionDetail, ffmpegFilter } = detection

  if (!triggered || dryRun) {
    if (!dryRun && outputPath) {
      await copyFile(inputPath, outputPath)
    }
    return {
      triggered:        false,
      flaggedHarmonics: [],
      notchesApplied:   [],
      detectionDetail,
      ffmpegFilter:     null,
      inputPath,
      outputPath:       dryRun ? null : outputPath,
    }
  }

  // Apply notch filters
  await runFfmpeg([
    '-i', inputPath,
    '-af', ffmpegFilter,
    '-map_metadata', '0',
    '-acodec', 'pcm_f32le',
    '-f', 'wav',
    outputPath,
  ])

  return {
    triggered:        true,
    flaggedHarmonics,
    notchesApplied:   flaggedHarmonics,
    detectionDetail,
    ffmpegFilter,
    inputPath,
    outputPath,
  }
}

/**
 * Build the FFmpeg equalizer filter string for a set of notch frequencies.
 * Exported so the pipeline stage can rebuild the filter after F0-based veto
 * trims the candidate set returned by analyzeHum().
 */
export function buildHumNotchFilter(frequencies, notchQ, notchDepth) {
  if (!frequencies?.length) return null
  return frequencies
    .map(f => `equalizer=f=${f}:width_type=q:width=${notchQ}:g=-${notchDepth}`)
    .join(',')
}

/**
 * Analyze audio for hum — detection only, no file I/O side effects.
 * The returned ffmpegFilter is built when triggered so the caller can apply it
 * directly (used by the pipeline stage to avoid a second analysis pass).
 *
 * Detection model (June 2026): instead of evaluating each harmonic in
 * isolation, the detector anchors on the 2nd harmonic (120 Hz for 60 Hz mains,
 * 100 Hz for 50 Hz mains). The 2nd harmonic is a more reliable anchor than the
 * fundamental because user-applied HPFs commonly suppress 60 Hz but leave
 * 120 Hz essentially untouched — and 120 Hz hum (transformer core, magnetic
 * coupling) is in practice more common than pure 60 Hz hum on modern gear.
 *
 * Coherence rules (with anchorDelta = anchor peak − floor):
 *   • Nothing is flagged unless anchorDelta ≥ anchorMinDeltaDb (default 6).
 *   • For k ≥ 3 (180 Hz+): Δₖ ≤ anchorDelta + slackForK. The default slack is
 *     3 dB; 180 Hz uses 1 dB because it's a very common male F0 and the cost of
 *     a false positive there is high.
 *   • For k = 1 (60 Hz fundamental): no upper bound vs. anchor — real hum's
 *     fundamental can be louder than the 2nd harmonic, and HPFs can push it
 *     arbitrarily low. Standard detectionThreshold and minAbsoluteLevel apply.
 *
 * This is the first line of defense against misclassifying vocal fundamentals
 * (typical F0 range 80–300 Hz) as hum. The pipeline stage adds a second line
 * by vetoing any surviving candidate that overlaps the speaker's voiced F0
 * histogram.
 *
 * @param {string} inputPath
 * @param {object} options
 * @returns {Promise<{ triggered, flaggedHarmonics, detectionDetail, ffmpegFilter, anchorFrequency, anchorDeltaDb }>}
 */
export async function analyzeHum(inputPath, options = {}) {
  const {
    fundamental            = 60,
    harmonics              = [1, 2, 3, 4, 5],
    detectionThreshold     = 8,
    minHarmonicsToTrigger  = 2,
    notchDepth             = 18,
    notchQ                 = 30,
    analysisWindow         = 50,
    minAbsoluteLevel       = -80,
    anchorMultiplier       = 2,
    anchorMinDeltaDb       = 6,
    coherenceSlackDb       = 3,
    strictSlackDb          = { 3: 1 },
  } = options

  const anchorFrequency = fundamental * anchorMultiplier
  if (!harmonics.includes(anchorMultiplier)) {
    throw new Error(
      `[hum-detect] anchorMultiplier (${anchorMultiplier}) must be in harmonics list`
    )
  }

  // Decode audio to raw float32 PCM samples (mono, 44.1 kHz, ≤10 s)
  const maxSamples = MAX_ANALYSIS_SECONDS * SAMPLE_RATE
  const samples    = await decodeToPcm(inputPath, maxSamples)

  // Compute magnitude spectrum (dBFS) via windowed FFT
  const magnitudeDb = computeMagnitudeSpectrum(samples, FFT_SIZE, SAMPLE_RATE)

  // First pass: per-harmonic peak / floor / delta, no flagging yet.
  const measurements = harmonics.map(multiplier => {
    const frequency = fundamental * multiplier
    const peakDb    = getPeakInBand(magnitudeDb, frequency, 2, SAMPLE_RATE, FFT_SIZE)
    const floorDb   = getMedianFloor(magnitudeDb, frequency, analysisWindow, 5, SAMPLE_RATE, FFT_SIZE)
    return {
      multiplier,
      frequency,
      peakDb,
      floorDb,
      deltaDb: peakDb - floorDb,
    }
  })

  const anchor      = measurements.find(m => m.multiplier === anchorMultiplier)
  const anchorDelta = anchor.deltaDb
  const anchorPasses = anchorDelta >= anchorMinDeltaDb

  // Second pass: apply coherence rules.
  const detectionDetail  = []
  const flaggedHarmonics = []

  for (const m of measurements) {
    const { multiplier, frequency, peakDb, floorDb, deltaDb } = m

    let flagged          = false
    let rejectionReason  = null

    if (!anchorPasses) {
      rejectionReason = 'anchor-failed'
    } else if (peakDb < minAbsoluteLevel) {
      rejectionReason = 'below-absolute-floor'
    } else if (multiplier === anchorMultiplier) {
      // Anchor coherence (anchorMinDeltaDb) IS the detection bar for the anchor
      // itself — bypass detectionThreshold so that anchor deltas between
      // anchorMinDeltaDb and detectionThreshold still count toward
      // minHarmonicsToTrigger.
      flagged = true
    } else if (deltaDb < detectionThreshold) {
      rejectionReason = 'below-threshold'
    } else if (multiplier === 1) {
      // Fundamental: no upper-bound coherence check (HPFs commonly suppress it
      // far below the anchor, and an unfiltered fundamental can sit above).
      flagged = true
    } else {
      const slack = strictSlackDb[multiplier] ?? coherenceSlackDb
      if (deltaDb <= anchorDelta + slack) {
        flagged = true
      } else {
        rejectionReason = 'anchor-coherence'
      }
    }

    detectionDetail.push({
      frequency,
      peakDb:           round2(peakDb),
      floorDb:          round2(floorDb),
      deltaDb:          round2(deltaDb),
      flagged,
      rejectionReason,
    })

    if (flagged) flaggedHarmonics.push(frequency)
  }

  // Single-harmonic guard — one flagged harmonic is more likely to be musical
  // content or a resonance than mains hum; log but do not trigger.
  if (flaggedHarmonics.length === 1) {
    console.warn(
      `[hum-detect] Single-harmonic detection at ${flaggedHarmonics[0]} Hz — ` +
      `not triggering (minHarmonicsToTrigger=${minHarmonicsToTrigger}). ` +
      `Likely musical content or resonance, not mains hum.`
    )
  }

  const triggered = flaggedHarmonics.length >= minHarmonicsToTrigger

  const ffmpegFilter = triggered
    ? buildHumNotchFilter(flaggedHarmonics, notchQ, notchDepth)
    : null

  return {
    triggered,
    flaggedHarmonics,
    detectionDetail,
    ffmpegFilter,
    anchorFrequency,
    anchorDeltaDb: round2(anchorDelta),
  }
}

// ── Audio decoding ─────────────────────────────────────────────────────────────

/**
 * Decode audio to raw float32 little-endian PCM (mono, 44.1 kHz).
 * Reads at most maxSamples samples (≤ 10 seconds of audio).
 * Uses spawn so stdout can be streamed without a maxBuffer ceiling.
 *
 * @param {string} inputPath
 * @param {number} maxSamples
 * @returns {Promise<Float32Array>}
 */
function decodeToPcm(inputPath, maxSamples) {
  const maxSeconds = maxSamples / SAMPLE_RATE

  return new Promise((resolve, reject) => {
    const chunks = []

    const proc = spawn(FFMPEG_PATH, [
      '-y',
      '-i',  inputPath,
      '-t',  String(maxSeconds),
      '-ac', '1',                 // mix to mono
      '-ar', String(SAMPLE_RATE),
      '-f',  'f32le',             // raw float32 little-endian
      '-',                        // stdout
    ])

    proc.stdout.on('data', chunk => chunks.push(chunk))

    proc.on('close', code => {
      // FFmpeg may exit non-zero (e.g. code 1) when the -t limit is hit mid-stream
      // on some builds; treat any output as success if we got data.
      if (code !== 0 && chunks.length === 0) {
        return reject(
          new Error(`[hum-detect] FFmpeg exited with code ${code} decoding ${inputPath}`)
        )
      }

      const buffer = Buffer.concat(chunks)
      // Use slice to guarantee byteOffset === 0 on the resulting ArrayBuffer,
      // which is required for correct Float32Array aliasing.
      const ab      = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      const samples = new Float32Array(ab)
      resolve(samples)
    })

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(
          new Error('[hum-detect] FFmpeg binary not found — ensure FFmpeg is installed and in PATH')
        )
      } else {
        reject(err)
      }
    })
  })
}

// ── FFT and spectral analysis ──────────────────────────────────────────────────

/**
 * Apply a Hann window to samples, zero-pad to fftSize, run the FFT, and
 * return the magnitude spectrum in dBFS for positive frequencies (bins 0 to
 * fftSize/2 - 1).
 *
 * Magnitude formula: 20 * log10(|X[k]| / fftSize), matching the spec.
 *
 * @param {Float32Array} samples
 * @param {number}       fftSize   — must be a power of two
 * @param {number}       sampleRate
 * @returns {Float64Array}  magnitudeDb[k] for k = 0 … fftSize/2 - 1
 */
function computeMagnitudeSpectrum(samples, fftSize, sampleRate) {  // eslint-disable-line no-unused-vars
  const real = new Float64Array(fftSize)
  const imag = new Float64Array(fftSize)
  const n    = Math.min(samples.length, fftSize)

  // Apply Hann window to the actual samples; remaining elements stay 0 (zero-padding)
  for (let i = 0; i < n; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)))
    real[i] = samples[i] * w
  }

  fftInPlace(real, imag)

  const halfSize    = fftSize >>> 1
  const magnitudeDb = new Float64Array(halfSize)
  for (let k = 0; k < halfSize; k++) {
    const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]) / fftSize
    magnitudeDb[k] = mag > 0 ? 20 * Math.log10(mag) : -300
  }

  return magnitudeDb
}

/**
 * Cooley-Tukey radix-2 iterative in-place FFT.
 * Modifies real[] and imag[] in place.
 *
 * @param {Float64Array} real
 * @param {Float64Array} imag
 */
function fftInPlace(real, imag) {
  const n = real.length

  // Bit-reversal permutation
  let j = 0
  for (let i = 1; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let tmp  = real[i]; real[i] = real[j]; real[j] = tmp
      tmp = imag[i]; imag[i] = imag[j]; imag[j] = tmp
    }
  }

  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const ang  = (-2 * Math.PI) / len
    const wRe  = Math.cos(ang)
    const wIm  = Math.sin(ang)
    const half = len >> 1

    for (let i = 0; i < n; i += len) {
      let curRe = 1.0
      let curIm = 0.0

      for (let k = 0; k < half; k++) {
        const uRe = real[i + k]
        const uIm = imag[i + k]
        const vRe = real[i + k + half] * curRe - imag[i + k + half] * curIm
        const vIm = real[i + k + half] * curIm + imag[i + k + half] * curRe

        real[i + k]        = uRe + vRe
        imag[i + k]        = uIm + vIm
        real[i + k + half] = uRe - vRe
        imag[i + k + half] = uIm - vIm

        const nextRe = curRe * wRe - curIm * wIm
        curIm        = curRe * wIm + curIm * wRe
        curRe        = nextRe
      }
    }
  }
}

// ── Frequency analysis helpers ─────────────────────────────────────────────────

/**
 * Convert a frequency in Hz to the nearest FFT bin index.
 */
function freqToIndex(freq, sampleRate, fftSize) {
  return Math.round((freq * fftSize) / sampleRate)
}

/**
 * Find the peak magnitude (dBFS) within ±halfWidthHz of centerHz.
 *
 * @param {Float64Array} magnitudeDb
 * @param {number}       centerHz
 * @param {number}       halfWidthHz   — ±2 Hz per spec
 * @param {number}       sampleRate
 * @param {number}       fftSize
 * @returns {number}
 */
function getPeakInBand(magnitudeDb, centerHz, halfWidthHz, sampleRate, fftSize) {
  const freqRes  = sampleRate / fftSize
  const center   = freqToIndex(centerHz, sampleRate, fftSize)
  const halfBins = Math.ceil(halfWidthHz / freqRes)
  const lo       = Math.max(0, center - halfBins)
  const hi       = Math.min(magnitudeDb.length - 1, center + halfBins)

  let peak = -Infinity
  for (let i = lo; i <= hi; i++) {
    if (magnitudeDb[i] > peak) peak = magnitudeDb[i]
  }
  return peak
}

/**
 * Compute the median magnitude (dBFS) in a ±windowHz band around centerHz,
 * excluding the ±excludeHz zone at the target frequency.
 *
 * Median is used (not mean) to resist bias from other tonal content in the
 * analysis window — see spec §Detection Algorithm §Step 2.
 *
 * @param {Float64Array} magnitudeDb
 * @param {number}       centerHz
 * @param {number}       windowHz      — ±50 Hz per spec
 * @param {number}       excludeHz     — ±5 Hz exclusion zone per spec
 * @param {number}       sampleRate
 * @param {number}       fftSize
 * @returns {number}
 */
function getMedianFloor(magnitudeDb, centerHz, windowHz, excludeHz, sampleRate, fftSize) {
  const freqRes     = sampleRate / fftSize
  const center      = freqToIndex(centerHz, sampleRate, fftSize)
  const windowBins  = Math.ceil(windowHz / freqRes)
  const excludeBins = Math.ceil(excludeHz / freqRes)
  const lo          = Math.max(0, center - windowBins)
  const hi          = Math.min(magnitudeDb.length - 1, center + windowBins)

  const values = []
  for (let i = lo; i <= hi; i++) {
    if (Math.abs(i - center) > excludeBins) {
      values.push(magnitudeDb[i])
    }
  }

  if (values.length === 0) return -Infinity

  values.sort((a, b) => a - b)
  const mid = values.length >> 1
  return values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid]
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function round2(n) {
  return n !== null && n !== undefined ? Math.round(n * 100) / 100 : null
}
