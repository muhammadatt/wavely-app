/**
 * POST /api/process — Audio processing endpoint.
 *
 * Accepts a multipart upload with:
 *   - file: audio file (WAV, MP3, FLAC, etc.)
 *   - preset: preset ID string
 *   - compliance: compliance target ID string
 *
 * Returns a multipart/mixed response:
 *   Part 1: application/json — { report, peaks }
 *   Part 2: audio/wav — processed audio blob
 *
 * Architecture note: This uses a single-response multipart approach for
 * minimal round-trips. A future improvement could use a two-step approach
 * (return JSON metadata first, then audio via a separate download URL)
 * which would enable:
 *   - Progress tracking for large files via SSE/WebSocket
 *   - Displaying the report before the full audio download completes
 *   - Resumable downloads for unreliable connections
 *   - Better caching of processed results
 * This is worth revisiting when batch processing is added in Sprint 5.
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { readFile, unlink } from 'fs/promises'
import { processAudio } from '../pipeline/index.js'
import { PRESETS, COMPLIANCE_TARGETS } from '../presets.js'

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
    const compliance = req.body.compliance

    if (!preset || !PRESETS[preset]) {
      return res.status(400).json({ error: `Invalid preset: ${preset}` })
    }
    if (!compliance || !COMPLIANCE_TARGETS[compliance]) {
      return res.status(400).json({ error: `Invalid compliance target: ${compliance}` })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: `Unsupported file format: ${ext}. Accepted: ${[...SUPPORTED_EXTENSIONS].join(', ')}`,
      })
    }

    // --- Process ---
    console.log(`Processing: ${req.file.originalname} | preset=${preset} compliance=${compliance}`)
    const startTime = Date.now()

    const { outputPath, report, peaks } = await processAudio(
      uploadedPath,
      req.file.originalname,
      preset,
      compliance,
    )

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`Processed in ${elapsed}s: ${req.file.originalname} | pass=${report.compliance_results.overall_pass}`)

    // --- Build multipart response ---
    const boundary = '----WavelyProcessingBoundary'
    const jsonPayload = JSON.stringify({ report, peaks })
    const audioBuffer = await readFile(outputPath)

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

    // Write audio binary
    res.write(audioBuffer)
    res.write(`\r\n--${boundary}--\r\n`)
    res.end()

    // Clean up processed output
    await unlink(outputPath).catch(() => {})
  } catch (err) {
    console.error('Processing error:', err)
    res.status(500).json({ error: 'Processing failed', message: err.message })
  } finally {
    // Clean up uploaded file
    if (uploadedPath) {
      await unlink(uploadedPath).catch(() => {})
    }
  }
})

export { router as processRoute }
