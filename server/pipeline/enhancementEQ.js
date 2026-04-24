/**
 * Stage 3 — Enhancement EQ (unified).
 *
 * Analyzes the spectral envelope of voiced speech using Meyda.js, compares
 * against the eqProfile's reference curve, and computes parametric EQ
 * parameters for FFmpeg's `equalizer` / `treble` filters.
 *
 * Reference: processing spec v3, Stage 3.
 *
 * Diagnostic bands (six):
 *   Body/warmth      100–250  Hz
 *   Mud/boxiness     200–400  Hz
 *   Clarity zone     400–700  Hz
 *   Upper mid        700–2000 Hz
 *   Presence         2000–5000 Hz
 *   Air/sibilance    6000–12000 Hz
 *
 * Every band is bi-directional: sign of the delta picks cut vs boost.
 * The only preset-specific logic remaining is the ACX noise-floor guard,
 * which halves HF boosts when the measured noise floor is close to -60 dBFS.
 */

import Meyda from "meyda"
import { readWavSamples } from "./wavReader.js"

const FFT_SIZE = 4096
const SAMPLE_RATE = 44100
const MAX_GAIN_DB = 5 // spec: ±5 dB maximum per band

// ── EQ Reference Profiles ────────────────────────────────────────────────────
// Each entry is the expected normalized energy (in dB relative to spectral
// mean) for recordings that "sound right" for the target use case.
// Values are relative to spectral mean across all six diagnostic bands.
const EQ_REFERENCES = {
  audiobook: {
    warmth: +16.0, // 100–250 Hz
    mud: +14.5, // 200–400 Hz
    clarity: +8.0, // 400–700 Hz
    upper_mid: -2.0, // 700 Hz–2 kHz 
    presence: -7.0, // 2–5 kHz
    air: -21.0, // 6–12 kHz
  },
  podcast: {
    warmth: +12.0, // 100–250 Hz
    mud: +11.5, // 200–400 Hz
    clarity: +8.0, // 400–700 Hz
    upper_mid: -2.0, // 700 Hz–2 kHz  ← new
    presence: -9.0, // 2–5 kHz
    air: -21.0, // 6–12 kHz
  },
  music: {
    warmth: +12.0, // 100–250 Hz
    mud: +11.5, // 200–400 Hz
    clarity: +8.0, // 400–700 Hz
    upper_mid: -2.0, // 700 Hz–2 kHz  ← new
    presence: -9.0, // 2–5 kHz
    air: -21.0, // 6–12 kHz
  },
  general: {
    warmth: +12.0, // 100–250 Hz
    mud: +11.5, // 200–400 Hz
    clarity: +8.0, // 400–700 Hz
    upper_mid: -2.0, // 700 Hz–2 kHz  ← new
    presence: -9.0, // 2–5 kHz
    air: -21.0, // 6–12 kHz
  },
  flat: {
    warmth: +0, // 100–250 Hz
    mud: +0, // 200–400 Hz
    clarity: +0, // 400–700 Hz
    upper_mid: +0, // 700 Hz–2 kHz  ← new
    presence: +0, // 2–5 kHz
    air: +0, // 6–12 kHz
  },
}

// ── EQ center frequencies / Q factors ────────────────────────────────────────
const EQ_CENTERS = {
  warmth: { freq: 180, q: 1.5 },
  mud: { freq: 285, q: 2.5 },
  clarity: { freq: 550, q: 2.0 },
  upper_mid: { freq: 1200, q: 1.0 },
  presence: { freq: 3500, q: 1.5 },
  air: { freq: 10000, q: 0.7, shelf: true },
}

// ── Diagnostic band frequency limits ─────────────────────────────────────────
const BANDS = {
  warmth: [100, 250],
  mud: [200, 400],
  clarity: [400, 700],
  upper_mid: [700, 2000],
  presence: [2000, 5000],
  air: [6000, 12000],
}

// ── Per-band treatment config (uniform across all profiles) ──────────────────
// gainScale keeps corrections partial so voices are pulled toward the
// reference, never snapped to it. maxGainDb reflects each band's perceptual
// sensitivity.
const BAND_CONFIG = {
  warmth: { gainScale: 0.5, maxGainDb: 3 },
  mud: { gainScale: 0.8, maxGainDb: MAX_GAIN_DB },
  clarity: { gainScale: 0.5, maxGainDb: 2 },
  upper_mid: { gainScale: 0.5, maxGainDb: 3 },
  presence: { gainScale: 0.7, maxGainDb: MAX_GAIN_DB },
  air: { gainScale: 0.4, maxGainDb: 2 },
}

// Band order matters for filter chaining: low → high.
const BAND_ORDER = ["warmth", "mud", "clarity", "upper_mid", "presence", "air"]

// ── Main API ─────────────────────────────────────────────────────────────────

/**
 * Analyze the spectral envelope and return FFmpeg EQ filter parameters.
 * Does NOT apply the EQ — caller passes these to applyParametricEQ().
 *
 * @param {string} wavPath
 * @param {string} eqProfile  - One of 'audiobook' | 'podcast' | 'music' | 'general'
 * @param {import('./frameAnalysis.js').FrameAnalysis} frameAnalysis
 * @param {number} noiseFloorDbfs  - For ACX noise-floor guard
 * @param {{ presetId?: string }} [opts]
 * @returns {EQResult}
 *
 * @typedef {Object} EQResult
 * @property {string[]} ffmpegFilters  - FFmpeg equalizer/treble filter strings (may be empty)
 * @property {Object}   bands          - Per-band EQ details for the report
 * @property {string}   profile        - eqProfile name used
 * @property {boolean}  applied        - True if any EQ was applied
 */
export async function analyzeSpectrum(
  wavPath,
  eqProfile,
  frameAnalysis,
  noiseFloorDbfs,
  opts = {},
) {
  const profile = EQ_REFERENCES[eqProfile] ? eqProfile : "general"
  const ref = EQ_REFERENCES[profile]
  const presetId = opts.presetId

  const { samples } = await readWavSamples(wavPath)

  // Collect voiced frames for analysis
  const voicedFrameBuffers = collectVoicedFrames(
    samples,
    frameAnalysis,
    FFT_SIZE,
  )

  if (voicedFrameBuffers.length === 0) {
    return noEQResult(profile)
  }

  // Compute average power spectrum across voiced frames
  const avgPowerSpectrum = averagePowerSpectrum(voicedFrameBuffers)

  // Measure average energy (in dB) in each diagnostic band
  const measured = measureBandEnergies(avgPowerSpectrum, SAMPLE_RATE, FFT_SIZE)

  // Compute spectral mean (average across all diagnostic bands, in dB)
  const specMeanDb =
    Object.values(measured).reduce((s, v) => s + v, 0) /
    Object.keys(measured).length

  // Convert to deviation from spectral mean (compare shape, not absolute level)
  const deviation = {}
  for (const band of Object.keys(measured)) {
    deviation[band] = measured[band] - specMeanDb
  }

  // How far each band deviates from its reference target
  const delta = {}
  for (const band of Object.keys(ref)) {
    delta[band] = deviation[band] - ref[band] // positive = band is elevated vs ref
  }

  // Build EQ decisions per band — fully bi-directional, uniform across profiles
  const bandResults = {}
  const filters = []

  for (const band of BAND_ORDER) {
    const result = decideBand({
      name: band,
      delta: delta[band],
      center: EQ_CENTERS[band],
      gainScale: BAND_CONFIG[band].gainScale,
      maxGainDb: BAND_CONFIG[band].maxGainDb,
    })
    bandResults[band] = result
    if (result.applied) filters.push(result.filter)
  }

  // --- ACX noise floor guard (Stage 3c) ---
  // If HF boosts are applied and the noise floor is close to -60 dBFS,
  // halve their gain to avoid pushing hiss above the ACX threshold.
  // Scoped to acx_audiobook only — voice_ready and others are unaffected.
  if (presetId === "acx_audiobook" && noiseFloorDbfs > -66) {
    for (let i = 0; i < filters.length; i++) {
      const f = filters[i]
      if (f.includes("f=10000") || f.includes("f=3500")) {
        // Halve the gain (works for both equalizer=...:g=X and treble=g=X:...)
        filters[i] = f.replace(
          /g=(-?)([\d.]+)/,
          (_, sign, g) => `g=${sign}${round2(parseFloat(g) / 2)}`,
        )
      }
    }
    // Sync the halved gain into the band results for the report.
    for (const band of ["presence", "air"]) {
      const br = bandResults[band]
      if (br.applied) {
        br.gain_db = round2(br.gain_db / 2)
        br.filter = br.filter.replace(
          /g=(-?)([\d.]+)/,
          (_, sign, g) => `g=${sign}${round2(parseFloat(g) / 2)}`,
        )
      }
    }
  }

  const applied = filters.length > 0

  // ── Per-band gain summary ──────────────────────────────────────────────────
  // Flat map used for both the [eq] console line and the Meta block in the
  // pipeline log file (appears under ctx.results.enhancementEQ.gainSummary).
  const gainSummary = {}
  for (const band of BAND_ORDER) {
    gainSummary[band] = bandResults[band].gain_db
  }

  const gainStr = BAND_ORDER.map((b) => {
    const g = bandResults[b].gain_db
    const sign = g > 0 ? "+" : ""
    return `${b}=${sign}${g}dB`
  }).join("  ")
  console.log(
    `[eq] ${profile} profile — ${filters.length} band(s) applied — ${gainStr}`,
  )

  return {
    ffmpegFilters: filters,
    bands: bandResults,
    gainSummary,
    profile,
    applied,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectVoicedFrames(samples, frameAnalysis, fftSize) {
  if (
    !frameAnalysis ||
    !frameAnalysis.frames ||
    frameAnalysis.frames.length === 0
  ) {
    // Fallback: use all samples in chunks
    const chunks = []
    for (let i = 0; i + fftSize <= samples.length; i += fftSize) {
      chunks.push(samples.slice(i, i + fftSize))
    }
    return chunks.slice(0, 200) // cap at 200 frames ~20s of analysis
  }

  const voiced = frameAnalysis.frames.filter((f) => !f.isSilence)
  const buffers = []

  for (const frame of voiced) {
    if (frame.offsetSamples + fftSize > samples.length) break
    buffers.push(
      samples.slice(frame.offsetSamples, frame.offsetSamples + fftSize),
    )
    if (buffers.length >= 200) break // cap at 200 frames
  }

  return buffers
}

function averagePowerSpectrum(frames) {
  const size = FFT_SIZE / 2 // Meyda powerSpectrum returns bufferSize/2 bins
  const sum = new Float64Array(size)

  // Configure Meyda globally for this synchronous extraction pass
  Meyda.bufferSize = FFT_SIZE

  for (const frame of frames) {
    const ps = Meyda.extract("powerSpectrum", frame)
    if (!ps) continue
    for (let i = 0; i < size && i < ps.length; i++) {
      sum[i] += ps[i]
    }
  }

  // Average
  for (let i = 0; i < size; i++) sum[i] /= frames.length
  return sum
}

function measureBandEnergies(powerSpectrum, sampleRate, fftSize) {
  const result = {}
  for (const [band, [lo, hi]] of Object.entries(BANDS)) {
    result[band] = bandEnergyDb(powerSpectrum, sampleRate, fftSize, lo, hi)
  }
  return result
}

function bandEnergyDb(ps, sampleRate, fftSize, freqLo, freqHi) {
  const binHz = sampleRate / fftSize
  const loIdx = Math.max(0, Math.floor(freqLo / binHz))
  const hiIdx = Math.min(ps.length - 1, Math.ceil(freqHi / binHz))
  let sum = 0
  let count = 0
  for (let i = loIdx; i <= hiIdx; i++) {
    sum += ps[i]
    count++
  }
  if (count === 0 || sum <= 0) return -80
  return 10 * Math.log10(sum / count)
}

/**
 * Bi-directional band decision. Positive delta → cut; negative delta → boost.
 * No separate trigger threshold: the 0.5 dB perception floor on the final
 * gain is the only gate, combined with partial correction via gainScale.
 */
function decideBand({ name, delta, center, gainScale, maxGainDb }) {
  if (!Number.isFinite(delta)) return unapplied(center)

  const magnitude = Math.abs(delta)
  let gainDb = magnitude * gainScale
  gainDb = Math.min(gainDb, maxGainDb)
  gainDb = round2(gainDb)

  if (gainDb < 0.5) return unapplied(center) // below perception threshold

  return delta > 0
    ? buildCut(name, gainDb, center)
    : buildBoost(name, gainDb, center)
}

function unapplied(center) {
  return { applied: false, freq_hz: center.freq, gain_db: 0 }
}

function buildCut(_name, gainDb, center) {
  const filter = center.shelf
    ? `treble=g=-${gainDb}:f=${center.freq}`
    : `equalizer=f=${center.freq}:t=q:w=${center.q}:g=-${gainDb}`
  return { applied: true, freq_hz: center.freq, gain_db: -gainDb, filter }
}

function buildBoost(_name, gainDb, center) {
  const filter = center.shelf
    ? `treble=g=${gainDb}:f=${center.freq}`
    : `equalizer=f=${center.freq}:t=q:w=${center.q}:g=${gainDb}`
  return { applied: true, freq_hz: center.freq, gain_db: gainDb, filter }
}

function noEQResult(profile) {
  const bands = {}
  const gainSummary = {}
  for (const band of BAND_ORDER) {
    bands[band] = unapplied(EQ_CENTERS[band])
    gainSummary[band] = 0
  }
  console.log(`[eq] ${profile} profile — 0 band(s) applied — no voiced frames`)
  return {
    ffmpegFilters: [],
    bands,
    gainSummary,
    profile,
    applied: false,
  }
}

function round2(n) {
  return Math.round(n * 100) / 100
}
