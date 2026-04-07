/**
 * POST /api/process — Audio processing endpoint.
 *
 * Accepts a multipart upload with:
 *   - file: audio file (WAV, MP3, FLAC, etc.)
 *   - preset: preset ID string
 *   - output_profile: output profile ID string (also accepts legacy 'compliance' field)
 *
 * Returns a multipart/mixed response:
 *   Part 1: application/json — { report, peaks }
 *   Part 2: audio/wav — processed audio blob
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { createReadStream } from 'fs'
import { stat, unlink } from 'fs/promises'
import { processAudio } from '../pipeline/index.js'
import { PRESETS, OUTPUT_PROFILES, resolveOutputProfileId } from '../presets.js'

const router = Router()

const upload = multer({
  dest: path.resolve(import.meta.dirname, '..', 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
})

const SUPPORTED_EXTENSIONS = new Set([
  '.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac', '.ogg',
])

router.post('/process', upload.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path
  try {
    // --- Validate inputs ---
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }

    const preset = req.body.preset
    // Accept both 'output_profile' and legacy 'compliance' field
    const rawProfile = req.body.output_profile || req.body.compliance
    const outputProfile = resolveOutputProfileId(rawProfile)

    if (!preset || !PRESETS[preset]) {
      return res.status(400).json({ error: `Invalid preset: ${preset}` })
    }
    if (!outputProfile || !OUTPUT_PROFILES[outputProfile]) {
      return res.status(400).json({ error: `Invalid output profile: ${rawProfile}` })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: `Unsupported file format: ${ext}. Accepted: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
      })
    }

    // --- Process ---
    // Allow per-request preset overrides
    const presetOverrides = {}

    // noise_eraser: separation backend override
    if (req.body.separation_model && preset === 'noise_eraser') {
      const allowedModels = ['demucs', 'convtasnet']
      if (!allowedModels.includes(req.body.separation_model)) {
        return res.status(400).json({ error: `Invalid separation_model: ${req.body.separation_model}` })
      }
      presetOverrides.separationModel = req.body.separation_model
    }

    // resemble_enhance: mode override (denoise | enhance)
    if (req.body.resemble_mode && preset === 'resemble_enhance') {
      const allowedModes = ['denoise', 'enhance']
      if (!allowedModes.includes(req.body.resemble_mode)) {
        return res.status(400).json({ error: `Invalid resemble_mode: ${req.body.resemble_mode}` })
      }
      presetOverrides.resembleMode = req.body.resemble_mode
    }

    // voicefixer: mode override (0 | 1 | 2)
    if (req.body.voicefixer_mode != null && preset === 'voicefixer') {
      const mode = parseInt(req.body.voicefixer_mode, 10)
      if (![0, 1, 2].includes(mode)) {
        return res.status(400).json({ error: `Invalid voicefixer_mode: ${req.body.voicefixer_mode}` })
      }
      presetOverrides.voiceFixerMode = mode
    }

    const overrideSummary = [
      presetOverrides.separationModel && `model=${presetOverrides.separationModel}`,
      presetOverrides.resembleMode    && `resemble_mode=${presetOverrides.resembleMode}`,
      presetOverrides.voiceFixerMode  != null && `voicefixer_mode=${presetOverrides.voiceFixerMode}`,
    ].filter(Boolean).join(' ')

    console.log(`Processing: ${req.file.originalname} | preset=${preset} output_profile=${outputProfile}${overrideSummary ? ` ${overrideSummary}` : ''}`)
    const startTime = Date.now()

    const { outputPath, report, peaks } = await processAudio(
      uploadedPath,
      req.file.originalname,
      preset,
      outputProfile,
      presetOverrides,
    )

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const certStatus = report.acx_certification
      ? `acx=${report.acx_certification.certificate}`
      : 'no-cert'
    console.log(`Processed in ${elapsed}s: ${req.file.originalname} | ${certStatus}`)

    // --- Build multipart response ---
    const boundary = '----WavelyProcessingBoundary'
    const jsonPayload = JSON.stringify({ report, peaks })

    res.setHeader('Content-Type', `multipart/mixed; boundary=${boundary}`)

    const parts = [
      `--${boundary}\r\n`,
      `Content-Type: application/json\r\n`,
      `Content-Disposition: form-data; name="metadata"\r\n`,
      `\r\n`,
      jsonPayload,
      `\r\n--${boundary}\r\n`,
      `Content-Type: audio/wav\r\n`,
      `Content-Disposition: form-data; name="audio"; filename="processed.wav"\r\n`,
      `\r\n`,
    ]

    // Write text parts
    for (const part of parts) {
      res.write(part)
    }

    // Stream audio binary instead of loading entire file into memory
    await new Promise((resolve, reject) => {
      const audioStream = createReadStream(outputPath)
      audioStream.on('error', reject)
      audioStream.on('end', resolve)
      audioStream.pipe(res, { end: false })
    })

    res.write(`\r\n--${boundary}--\r\n`)
    res.end()

    // Clean up processed output
    await unlink(outputPath).catch(() => {})
  } catch (err) {
    const status = err.statusCode || 500
    console.error('Processing error:', err)
    res.status(status).json({ error: err.message })
  } finally {
    // Clean up uploaded file
    if (uploadedPath) {
      await unlink(uploadedPath).catch(() => {})
    }
  }
})

export { router as processRoute }
