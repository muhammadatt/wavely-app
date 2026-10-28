/**
 * POST /api/spot/:operation — Run a single DSP operation on a short clip.
 *
 * Spot effects run on a user selection (typically a few seconds), bypass the
 * preset chain entirely, and return the processed WAV directly. No job store,
 * no polling — the response is the processed audio.
 *
 * Multipart body:
 *   - file:   audio file (WAV — 32-bit float preferred)
 *   - params: JSON string of operation-specific parameters
 *
 * Currently supported operations:
 *   - vocal_saturation
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { unlink } from 'fs/promises'
import { tempPath, removeTmp } from '../lib/ffmpeg.js'
import { runVocalSaturation } from '../pipeline/enhancement.js'
import { openGate } from '../lib/entitlements.js'
import { trackWork } from '../lib/requestLog.js'

const upload = multer({
  dest: path.resolve(import.meta.dirname, '..', 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB — spot clips are short
})

// ── Operation registry ────────────────────────────────────────────────────────
// Each handler receives (inputPath, outputPath, params) and resolves when the
// output WAV is written. Add new spot operations here.
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
}

const unlimited = (_req, _res, next) => next()

/**
 * @param {object}   [deps]
 * @param {Function} [deps.gate]  entitlement gate factory (lib/entitlements.js);
 *                                the default lets every request through
 * @param {Function} [deps.limit] concurrency middleware (holdSlot in
 *                                lib/jobQueue.js); runs before the upload
 */
export function createSpotRoute({ gate = openGate, limit = unlimited } = {}) {
  const router = Router()
  const featureOf = req => (OPERATIONS[req.params.operation] ? 'spotEffects' : null)

  // An unknown spot operation is refused first: it has no feature, so the sign-in
  // check would wave it through to take a slot and an upload it can never use.
  const known = (req, res, next) => {
    if (OPERATIONS[req.params.operation]) return next()
    res.status(400).json({ error: `Unknown spot operation: ${req.params.operation}`, supported: Object.keys(OPERATIONS) })
  }

  // Sign-in and the concurrency slot are checked BEFORE multer reads the body.
  router.post('/spot/:operation', known, gate.signIn(featureOf), limit, upload.single('file'), gate(featureOf), async (req, res) => {
    const slot = res.locals.slot
    const releaseSlot = slot?.claim()
    const uploadedPath = req.file?.path
    let outputPath = null

    try {
      // The client left while the gate was checking; its slot is already free.
      if (slot && !releaseSlot) return

      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' })
      }

      const op = OPERATIONS[req.params.operation]

      let params = {}
      if (req.body.params) {
        try {
          params = JSON.parse(req.body.params)
        } catch {
          return res.status(400).json({ error: 'Invalid params JSON' })
        }
      }

      outputPath = tempPath('.wav')
      const start = Date.now()
      await trackWork(res, op.run(uploadedPath, outputPath, params))
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
      if (outputPath) removeTmp(outputPath).catch(() => {})
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Spot processing failed' })
      }
    } finally {
      releaseSlot?.()
      if (uploadedPath) await unlink(uploadedPath).catch(() => {})
    }
  })

  return router
}
