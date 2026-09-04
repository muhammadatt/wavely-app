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
 *   - vad       — voiced/silence frame mask for the auto-leveler
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
import { FRAME_DURATION_S } from '../pipeline/frameAnalysis.js'

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

/**
 * Voice-activity analysis for the realtime auto-leveler.
 *
 * The auto-leveler's whole DSP ports to the browser — K-weighting, clip
 * segmentation, per-clip LUFS, drift shaping, crossfades — except for the one
 * input it cannot compute there: Silero's voiced/silence labels. So this route
 * returns that mask and nothing else, and the client does the rest.
 *
 * RUNS ARE THE WIRE FORMAT, NOT FRAMES. A frame is 25 ms, so an hour-long
 * chapter is 144,000 of them; as objects that is tens of megabytes of JSON to
 * carry one boolean each. Voiced runs are the same information at the size of
 * the speech structure rather than the frame grid — a few hundred pairs for a
 * chapter — and the client expands them back to a mask in a loop.
 *
 * FRAME INDICES, NOT SAMPLE OFFSETS. The pipeline decodes to 44.1 kHz, so
 * sample offsets would need the same rescaling the sibilance route documents,
 * with the same silent drift when a caller forgets. A frame index plus
 * frameDurationS is rate-free: the client multiplies by its own rate and lands
 * on its own grid exactly, because that is how frameBoundary defines the grid
 * on this side too.
 *
 * Mono is forced through the preset's channelOutput — VAD is a single-channel
 * decision, and an unmixed stereo input would reach it as interleaved noise.
 */
async function runVadAnalysis(inputPath) {
  return withAnalysisContext(
    {
      inputPath,
      stages: ['decode', 'monoMixdown', 'analyzeFramesRaw'],
      preset: { channelOutput: 'mono' },
    },
    async (ctx) => {
      const metrics = ctx.results.metrics ?? {}
      const frames = metrics.frames ?? []

      // Run-length encode the voiced frames: [startInclusive, endExclusive).
      const voicedRuns = []
      let runStart = -1
      for (let f = 0; f < frames.length; f++) {
        const voiced = !frames[f].isSilence
        if (voiced && runStart < 0) runStart = f
        else if (!voiced && runStart >= 0) {
          voicedRuns.push([runStart, f])
          runStart = -1
        }
      }
      if (runStart >= 0) voicedRuns.push([runStart, frames.length])

      return {
        sampleRate:     ANALYSIS_SAMPLE_RATE,
        frameDurationS: FRAME_DURATION_S,
        numFrames:      frames.length,
        voicedRuns,
        // The noise floor arms the leveler's headroom cap: it may not lift a
        // clip so far that the room tone comes up with it.
        noiseFloorDbfs:       metrics.noiseFloorDbfs ?? null,
        silenceThresholdDbfs: metrics.silenceThresholdDbfs ?? null,
        voicedRmsDbfs:        metrics.voicedRmsDbfs ?? null,
        durationS:            frames.length * FRAME_DURATION_S,
      }
    },
  )
}

const KINDS = {
  sibilance: { label: 'Sibilance', run: runSibilanceAnalysis },
  vad:       { label: 'Voice activity', run: runVadAnalysis },
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
      (result.voicedRuns
        ? `${result.voicedRuns.length} voiced runs / ${result.numFrames} frames`
        : `${result.detectedCount ?? 0} events`),
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
