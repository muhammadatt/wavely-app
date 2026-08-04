/**
 * POST /api/analyze/:kind — Run an analysis pass and return JSON.
 *
 * The counterpart to /api/spot: same multipart shape and same short-clip
 * assumptions, but the answer is measurements rather than audio. Realtime
 * effects whose parameters cannot be derived in the browser use this to get a
 * one-off analysis they then work against locally.
 *
 * Multipart body:
 *   - file:   audio file (WAV — 32-bit float preferred)
 *   - params: JSON string of analysis-specific parameters
 *
 * Currently supported kinds:
 *   - sibilance — sibilance event map for the clip-gain de-esser
 *
 * SAMPLE RATE. The pipeline decodes everything to 44.1 kHz (INTERNAL_SAMPLE_RATE
 * in lib/ffmpeg.js), so returned sample offsets are in the analysis rate, not
 * whatever the caller uploaded. The response always carries `sampleRate` and
 * callers MUST rescale against their own — a 48 kHz project would otherwise
 * place every event about 9% early.
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { unlink } from 'fs/promises'
import { withAnalysisContext } from '../pipeline/index.js'
import { applyClipGainDeEsser } from '../pipeline/clipGainDeEsser.js'

const router = Router()

const upload = multer({
  dest: path.resolve(import.meta.dirname, '..', 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — analysis clips are short
})

/** Analysis rate — must track INTERNAL_SAMPLE_RATE in lib/ffmpeg.js. */
const ANALYSIS_SAMPLE_RATE = 44100

/**
 * Sibilance analysis for the realtime clip-gain de-esser.
 *
 * WHY THE FRAME PASS IS NOT OPTIONAL. Detection reads two things off
 * ctx.results.metrics that only analyzeFramesRaw produces: the measured noise
 * floor, which arms the detector's absolute energy gate, and the VAD frame
 * labels, which are the voiced reference for every context-RMS measurement.
 * Without them the gate is disabled outright (noise_floor_dbfs stays null) and
 * context RMS falls back to "any frame that is not part of an event". The pass
 * would still return events — just not the ones the real chain would produce,
 * which is worse than returning nothing.
 *
 * Mono is forced through the preset's channelOutput, because detection is a
 * single-channel measurement and a stereo input would otherwise reach the
 * detector unmixed.
 */
async function runSibilanceAnalysis(inputPath, params) {
  const detection = params.detection ?? {}
  const minDurationMs = params.minDurationMs ?? 25
  const contextWindowMs = params.contextWindowMs ?? 80

  const analyzeConfig = {
    enabled: true,
    minDurationMs,
    contextWindowMs,
    sibilanceDetection: detection,
    // The decision pass runs again client-side on every knob move, so these
    // only set what the first response reports. They are echoed back so a
    // caller can tell which settings produced the treated set it received.
    stridentCeilingDb: params.stridentCeilingDb ?? 6.0,
    nonStridentCeilingDb: params.nonStridentCeilingDb ?? -4.0,
    reductionRatio: params.reductionRatio ?? 0.5,
    maxReductionDb: params.maxReductionDb ?? 8.0,
  }

  return withAnalysisContext(
    {
      inputPath,
      stages: ['decode', 'monoMixdown', 'analyzeFramesRaw', 'clipGainDeEsserAnalyze'],
      preset: { channelOutput: 'mono', clipGainDeEsserAnalyze: analyzeConfig },
    },
    async (ctx) => {
      const bundle = ctx.globalParams.clipGainDeEsser
      const noiseFloorDbfs = ctx.results.metrics?.noiseFloorDbfs ?? null

      if (!bundle?.applied) {
        return {
          sampleRate: ANALYSIS_SAMPLE_RATE,
          measuredEvents: [],
          detectedCount: 0,
          noiseFloorDbfs,
          reason: bundle?.reason ?? 'no_events',
          config: analyzeConfig,
        }
      }

      // decisionOnly: we want the measurements, not a rendered WAV. The
      // envelope is built in the browser from these numbers.
      const result = await applyClipGainDeEsser(
        ctx.currentPath,
        null,
        bundle.eventsPath,
        bundle.config,
        bundle.frames,
        { decisionOnly: true },
      )

      return {
        sampleRate: ANALYSIS_SAMPLE_RATE,
        // Every event that reached a gain decision, treated or not — the client
        // re-decides locally and needs the ones this pass declined.
        measuredEvents: result.measuredEvents ?? [],
        detectedCount: result.eventCount ?? 0,
        treatedCount: result.treatedCount ?? 0,
        skippedInRange: result.skippedInRange ?? 0,
        skippedNoContext: result.skippedNoContext ?? 0,
        noiseFloorDbfs,
        config: analyzeConfig,
      }
    },
  )
}

const KINDS = {
  sibilance: { label: 'Sibilance', run: runSibilanceAnalysis },
}

router.post('/analyze/:kind', upload.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }

    const kind = KINDS[req.params.kind]
    if (!kind) {
      return res.status(400).json({
        error: `Unknown analysis kind: ${req.params.kind}`,
        supported: Object.keys(KINDS),
      })
    }

    let params = {}
    if (req.body?.params) {
      try {
        params = JSON.parse(req.body.params)
      } catch {
        return res.status(400).json({ error: 'params is not valid JSON' })
      }
    }

    const started = Date.now()
    const result = await kind.run(uploadedPath, params)
    console.log(
      `[analyze/${req.params.kind}] ${Date.now() - started}ms — ` +
      `${result.detectedCount ?? 0} events`,
    )

    res.json(result)
  } catch (err) {
    console.error(`[analyze/${req.params.kind}] failed:`, err)
    res.status(500).json({ error: err.message ?? 'Analysis failed' })
  } finally {
    if (uploadedPath) await unlink(uploadedPath).catch(() => {})
  }
})

export { router as analyzeRoute }
