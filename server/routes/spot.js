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

const router = Router()

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
      drive:        params.drive,
      wetDry:       params.wetDry,
      bias:         params.bias,
      lowCrossover: params.lowCrossover,
      midCrossover: params.midCrossover,
      softness:     params.softness,
    }),
  },
}

router.post('/spot/:operation', upload.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path
  let outputPath = null

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

    outputPath = tempPath('.wav')
    const start = Date.now()
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
    if (outputPath) removeTmp(outputPath).catch(() => {})
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Spot processing failed' })
    }
  } finally {
    if (uploadedPath) await unlink(uploadedPath).catch(() => {})
  }
})

export { router as spotRoute }
