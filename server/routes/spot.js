/**
 * POST /api/spot/:operation — Run a single DSP operation on a short clip.
 *
 * Spot effects run on a user selection, bypass the preset chain entirely, and
 * return the processed WAV directly — except an operation marked `async` below,
 * which answers 202 { jobId } and is collected through /api/jobs like the
 * preset chain.
 *
 * Multipart body:
 *   - file:   audio file (WAV — 32-bit float preferred)
 *   - params: JSON string of operation-specific parameters
 *
 * Currently supported operations:
 *   - vocal_saturation
 *   - noise_reduction   DeepFilterNet3 / RNNoise on a selection (the Noise
 *                       Reduction plugin; see pipeline/spotNoiseReduce.js)
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { unlink } from 'fs/promises'
import { tempPath, removeTmp } from '../lib/ffmpeg.js'
import { runVocalSaturation } from '../pipeline/enhancement.js'
import { runSpotNoiseReduction } from '../pipeline/spotNoiseReduce.js'
import { parseServerParams as parseNoiseReductionParams } from '../../src/audio/noiseReductionParams.js'
import { openGate } from '../lib/entitlements.js'
import { createJob, completeJob, failJob } from '../lib/jobStore.js'

const upload = multer({
  dest: path.resolve(import.meta.dirname, '..', 'uploads'),
  // 512 MB, as /api/analyze. 100 MB was sized for few-second clips; noise
  // reduction is run on whole chapters, and a mono 44.1 kHz float upload is
  // 635 MB an hour, so this admits ~45 min mono / ~22 min stereo. Multer
  // streams to disk, so the ceiling costs nothing until it is used.
  limits: { fileSize: 512 * 1024 * 1024 },
})

// ── Operation registry ────────────────────────────────────────────────────────
// Each handler receives (inputPath, outputPath, params) and resolves when the
// output WAV is written. Add new spot operations here.
//
//   feature   the plan feature (src/auth/plans.js) the gate checks; defaults
//             to the catch-all 'spotEffects'
//   validate  optional: throws on bad params, answered as a 400 before any
//             processing starts
//   async     answer 202 { jobId } at once and run in the background; the
//             client polls GET /api/jobs/:jobId and fetches the WAV from
//             /api/jobs/:jobId/download. For anything that can outlast the
//             proxy's ~100 s timeout on a long selection — DF3 on a chapter
//             does — the same reason the preset chain is job-based.
const OPERATIONS = {
  vocal_saturation: {
    label: 'VocalSaturation',
    run: (inputPath, outputPath, params) => runVocalSaturation(inputPath, outputPath, {
      drive:         params.drive,
      wetDry:        params.wetDry,
      bias:          params.bias,
      lowCrossover:  params.lowCrossover,
      midCrossover:  params.midCrossover,
      softness:      params.softness,
      lowDriveMult:  params.lowDriveMult,
      midDriveMult:  params.midDriveMult,
      highDriveMult: params.highDriveMult,
    }),
  },
  noise_reduction: {
    label: 'NoiseReduction',
    feature: 'noiseReduction',
    validate: parseNoiseReductionParams,
    async: true,
    run: (inputPath, outputPath, params) => runSpotNoiseReduction(inputPath, outputPath, params),
  },
}

/**
 * @param {object}   [deps]
 * @param {Function} [deps.gate]  entitlement gate factory (lib/entitlements.js);
 *                                the default lets every request through
 */
export function createSpotRoute({ gate = openGate } = {}) {
  const router = Router()

  router.post('/spot/:operation', upload.single('file'), gate(req => {
    const op = OPERATIONS[req.params.operation]
    return op ? (op.feature ?? 'spotEffects') : null
  }), async (req, res) => {
    const uploadedPath = req.file?.path
    let outputPath = null
    // Set once a background job owns the upload and the output.
    let handedOff = false

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' })
      }

      const op = OPERATIONS[req.params.operation]
      if (!op) {
        return res.status(400).json({ error: `Unknown spot operation: ${req.params.operation}` })
      }

      let params = {}
      if (req.body.params) {
        try {
          params = JSON.parse(req.body.params)
        } catch {
          return res.status(400).json({ error: 'Invalid params JSON' })
        }
      }
      if (op.validate) {
        try {
          op.validate(params)
        } catch (err) {
          return res.status(400).json({ error: err.message })
        }
      }

      outputPath = tempPath('.wav')
      const start = Date.now()

      if (op.async) {
        const jobId = createJob()
        handedOff = true
        res.status(202).json({ jobId })
        const jobOutput = outputPath
        Promise.resolve()
          .then(() => op.run(uploadedPath, jobOutput, params))
          .then(summary => {
            completeJob(jobId, { report: summary ?? null, peaks: null, outputPath: jobOutput })
            const elapsed = ((Date.now() - start) / 1000).toFixed(2)
            console.log(`[spot] ${req.params.operation} job ${jobId} ${elapsed}s (${req.file.size} bytes in)`)
          })
          .catch(err => {
            failJob(jobId, err.message || 'Spot processing failed')
            removeTmp(jobOutput).catch(() => {})
            console.error(`[spot] ${req.params.operation} job ${jobId} failed:`, err)
          })
          .finally(() => unlink(uploadedPath).catch(() => {}))
        return
      }

      await op.run(uploadedPath, outputPath, params)
      const elapsed = ((Date.now() - start) / 1000).toFixed(2)
      console.log(`[spot] ${req.params.operation} ${elapsed}s (${req.file.size} bytes in)`)

      res.setHeader('Content-Type', 'audio/wav')
      res.sendFile(outputPath, err => {
        // Clean up regardless of send success
        removeTmp(outputPath).catch(() => {})
        if (err && !res.headersSent) {
          console.error(`[spot] send failed:`, err)
        }
      })
    } catch (err) {
      console.error(`[spot] ${req.params.operation} failed:`, err)
      if (outputPath && !handedOff) removeTmp(outputPath).catch(() => {})
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Spot processing failed' })
      }
    } finally {
      if (uploadedPath && !handedOff) await unlink(uploadedPath).catch(() => {})
    }
  })

  return router
}
