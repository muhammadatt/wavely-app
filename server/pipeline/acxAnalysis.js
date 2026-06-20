/**
 * ACX Audio Compliance Analysis — read-only pipeline.
 *
 * Measures a submitted audio file without any processing or modification.
 * Reuses the production measurement utilities (measure.js, frameAnalysis.js,
 * humEQ.js, sibilanceEvents.js) to produce a compliance report identical in
 * format to the post-processing report, but derived entirely from the source.
 *
 * Report shape:
 *   filename, duration_seconds, file_metadata,
 *   measurements (rms, true_peak, noise_floor, voiced_rms),
 *   acx_certification (6-point pass/fail),
 *   quality_metrics (crest_factor, hum, sibilant_events)
 */

import { measureRmsAndPeak, checkAcxCertification } from './measure.js'
import { analyzeFrames }                             from './frameAnalysis.js'
import { analyzeHum }                                from './humEQ.js'
import { analyzeSibilanceEvents }                    from './sibilanceEvents.js'
import { decodeToFloat32, mixdownToMono, tempPath, removeTmp } from '../lib/ffmpeg.js'
import { ffprobe }                                   from '../lib/exec-ffmpeg.js'

// Crest factor quality bands (dB) — voiced-peak to voiced-RMS ratio
const CF_OVER_COMPRESSED = 8
const CF_IDEAL_MAX       = 14
const CF_DYNAMIC_MAX     = 20

// Sibilance: events per minute thresholds
const SIB_MODERATE_RATE = 5   // events/min
const SIB_HIGH_RATE     = 15  // events/min

/**
 * Run read-only ACX compliance analysis on an uploaded file.
 *
 * @param {string} inputPath     - Temp path of the uploaded file
 * @param {string} originalName  - Original filename (for report only)
 * @returns {Promise<object>}    - Structured compliance report
 */
export async function analyzeAudioForAcx(inputPath, originalName = '') {
  const tmpFiles = []
  const tmp = (ext = '.wav') => {
    const p = tempPath(ext)
    tmpFiles.push(p)
    return p
  }

  try {
    // ── 1. Probe original file metadata ──────────────────────────────────────
    const metadata = await probeFileMetadata(inputPath)

    // ── 2. Decode to float32 44.1 kHz (preserve original channel count) ──────
    const decodedPath = tmp()
    await decodeToFloat32(inputPath, decodedPath)

    // ── 3. RMS + true peak + hum detection (run in parallel) ─────────────────
    const [{ rmsDbfs, truePeakDbfs }, humResult] = await Promise.all([
      measureRmsAndPeak(decodedPath),
      analyzeHum(decodedPath).catch(err => {
        console.warn('[acx-check] Hum detection skipped:', err.message)
        return null
      }),
    ])

    // ── 4. Mono mixdown for VAD-based frame analysis ──────────────────────────
    const monoPath = tmp()
    await mixdownToMono(decodedPath, monoPath)

    // ── 5. Frame analysis — noise floor + voiced RMS ──────────────────────────
    const frameAnalysis = await analyzeFrames(monoPath)
    const { noiseFloorDbfs, voicedRmsDbfs } = frameAnalysis

    // ── 6. Sibilance event count (optional, Python subprocess) ────────────────
    let sibilantCount = null
    try {
      // Minimal pipeline-context shim — matches the fields analyzeSibilanceEvents reads:
      //   ctx.currentPath, ctx.tmp, ctx.results.metrics.{noiseFloorDbfs, frames}, ctx.presetId
      const ctx = {
        currentPath: monoPath,
        presetId:    'acx_check',
        tmp: (ext = '.json') => {
          const p = tempPath(ext)
          tmpFiles.push(p)
          return p
        },
        results: {
          metrics: {
            noiseFloorDbfs,
            frames: frameAnalysis.frames ?? null,
          },
        },
        _f0Contour: null,
      }
      const { events } = await analyzeSibilanceEvents(ctx, {})
      sibilantCount = Array.isArray(events?.events) ? events.events.length : null
    } catch (err) {
      console.warn('[acx-check] Sibilance detection skipped:', err.message)
    }

    // ── 7. Crest factor (true peak vs voiced RMS — dynamics quality proxy) ────
    const crestFactorDb = round1(truePeakDbfs - voicedRmsDbfs)

    // ── 8. ACX 6-point certification ─────────────────────────────────────────
    const measurements = { rmsDbfs, truePeakDbfs, noiseFloorDbfs }
    const fileMetadata = {
      sampleRate: metadata.sampleRate,
      bitDepth:   metadata.bitDepth,
      channels:   metadata.channels,
    }
    const acxCert = checkAcxCertification(measurements, fileMetadata)

    // ── 9. Assemble report ────────────────────────────────────────────────────
    const durationSeconds = metadata.duration

    return {
      filename:         originalName,
      duration_seconds: durationSeconds ? round1(durationSeconds) : null,
      file_metadata: {
        sample_rate_hz: metadata.sampleRate,
        bit_depth:      metadata.bitDepth,
        channels:       metadata.channels,
        codec:          metadata.codec,
        size_bytes:     metadata.sizeBytes,
      },
      measurements: {
        rms_dbfs:         rmsDbfs,
        true_peak_dbfs:   truePeakDbfs,
        noise_floor_dbfs: noiseFloorDbfs,
        voiced_rms_dbfs:  voicedRmsDbfs,
      },
      acx_certification: acxCert,
      quality_metrics: {
        crest_factor: {
          db:     crestFactorDb,
          rating: rateCrestFactor(crestFactorDb),
        },
        hum: {
          detected:    humResult?.triggered ?? null,
          frequencies: humResult?.flaggedHarmonics ?? [],
        },
        sibilant_events: {
          count:  sibilantCount,
          rate_per_minute: sibilantCount !== null && durationSeconds
            ? round1((sibilantCount / durationSeconds) * 60)
            : null,
          rating: rateSibilance(sibilantCount, durationSeconds),
        },
      },
    }

  } finally {
    await Promise.all(tmpFiles.map(f => removeTmp(f)))
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function probeFileMetadata(filePath) {
  const probe    = await ffprobe(filePath)
  const stream   = probe.streams?.find(s => s.codec_type === 'audio')
  const format   = probe.format

  const sampleRate = parseInt(stream?.sample_rate, 10) || null
  const channels   = stream?.channels ?? null
  const duration   = parseFloat(format?.duration) || null
  const sizeBytes  = parseInt(format?.size, 10) || null
  const codec      = stream?.codec_name ?? null

  // Bit depth label — must match the expected strings in checkAcxCertification
  let bitDepth = '?'
  if (codec === 'mp3') {
    const br = parseInt(stream?.bit_rate, 10) || parseInt(format?.bit_rate, 10) || 0
    bitDepth = `MP3 ${Math.round(br / 1000)} kbps`
  } else if (stream?.sample_fmt) {
    const fmtMap = {
      s16: '16-bit PCM', s16p: '16-bit PCM',
      s24: '24-bit PCM', s24p: '24-bit PCM',
      s32: '32-bit PCM', s32p: '32-bit PCM',
      flt: '32-bit float', fltp: '32-bit float',
      dbl: '64-bit float', dblp: '64-bit float',
    }
    bitDepth = fmtMap[stream.sample_fmt] ?? stream.sample_fmt
  }

  return { sampleRate, channels, duration, sizeBytes, codec, bitDepth }
}

function rateCrestFactor(db) {
  if (db === null || !Number.isFinite(db)) return null
  if (db < CF_OVER_COMPRESSED) return 'over_compressed'
  if (db < CF_IDEAL_MAX)       return 'ideal'
  if (db < CF_DYNAMIC_MAX)     return 'good'
  return 'very_dynamic'
}

function rateSibilance(count, durationSeconds) {
  if (count === null) return null
  const rate = durationSeconds ? (count / durationSeconds) * 60 : count
  if (rate < SIB_MODERATE_RATE) return 'low'
  if (rate < SIB_HIGH_RATE)     return 'moderate'
  return 'high'
}

function round1(n) {
  return n !== null && Number.isFinite(n) ? Math.round(n * 10) / 10 : null
}
