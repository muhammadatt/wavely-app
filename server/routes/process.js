/**
 * POST /api/process — Submit an audio processing job.
 *
 * Accepts a multipart upload with:
 *   - file: audio file (WAV, MP3, FLAC, etc.)
 *   - preset: preset ID string
 *   - output_profile: output profile ID string (also accepts legacy 'compliance' field)
 *
 * Returns 202 { jobId } immediately. The pipeline runs in the background.
 * Poll GET /api/jobs/:jobId for status, then GET /api/jobs/:jobId/download
 * to retrieve the processed audio once status === 'done'.
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { unlink } from 'fs/promises'
import { processAudio } from '../pipeline/index.js'
import { PRESETS, OUTPUT_PROFILES, resolveOutputProfileId } from '../presets.js'
import { createJob, completeJob, failJob } from '../lib/jobStore.js'

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
  let jobAccepted = false

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

    // --- Per-request preset overrides ---
    const presetOverrides = {}

    // noise_eraser: separation backend override
    if (req.body.separation_model && preset === 'noise_eraser') {
      const allowedModels = ['demucs', 'convtasnet']
      if (!allowedModels.includes(req.body.separation_model)) {
        return res.status(400).json({ error: `Invalid separation_model: ${req.body.separation_model}` })
      }
      presetOverrides.separationModel = req.body.separation_model
    }

    // clearervoice_eraser: model override
    if (req.body.clearervoice_model && preset === 'clearervoice_eraser') {
      const allowedModels = ['mossformer2_48k', 'frcrn_16k']
      if (!allowedModels.includes(req.body.clearervoice_model)) {
        return res.status(400).json({ error: `Invalid clearervoice_model: ${req.body.clearervoice_model}` })
      }
      presetOverrides.clearervoiceModel = req.body.clearervoice_model
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
      presetOverrides.separationModel   && `model=${presetOverrides.separationModel}`,
      presetOverrides.clearervoiceModel && `clearervoice_model=${presetOverrides.clearervoiceModel}`,
      presetOverrides.resembleMode      && `resemble_mode=${presetOverrides.resembleMode}`,
      presetOverrides.voiceFixerMode    != null && `voicefixer_mode=${presetOverrides.voiceFixerMode}`,
    ].filter(Boolean).join(' ')

    // --- Accept job, return immediately ---
    // The pipeline runs in the background. Cloudflare's 100 s proxy timeout
    // only applies to the initial upload request, which now completes well
    // within a few seconds. The client polls /api/jobs/:jobId for progress.
    const jobId = createJob()
    jobAccepted = true

    console.log(`Job ${jobId} accepted: ${req.file.originalname} | preset=${preset} output_profile=${outputProfile}${overrideSummary ? ` ${overrideSummary}` : ''}`)
    res.status(202).json({ jobId })

    // --- Background pipeline ---
    const startTime = Date.now()
    Promise.resolve()
      .then(() => processAudio(uploadedPath, req.file.originalname, preset, outputProfile, presetOverrides))
      .then(({ outputPath, report, peaks }) => {
        completeJob(jobId, { report, peaks, outputPath })
        const elapsed    = ((Date.now() - startTime) / 1000).toFixed(1)
        const certStatus = report.acx_certification
          ? `acx=${report.acx_certification.certificate}`
          : 'no-cert'
        console.log(`Job ${jobId} done in ${elapsed}s: ${req.file.originalname} | ${certStatus}`)
      })
      .catch(err => {
        failJob(jobId, err.message)
        console.error(`Job ${jobId} failed:`, err)
      })
      .finally(() => {
        // Uploaded file is no longer needed once the pipeline finishes
        unlink(uploadedPath).catch(() => {})
      })

  } catch (err) {
    // Validation error — pipeline was never started
    if (!res.headersSent) {
      res.status(err.statusCode || 400).json({ error: err.message })
    }
  } finally {
    // Only clean up the upload immediately on validation failure.
    // If the job was accepted, the background task's .finally() handles it.
    if (!jobAccepted && uploadedPath) {
      await unlink(uploadedPath).catch(() => {})
    }
  }
})

export { router as processRoute }
