/**
 * ACX Audio Compliance Checker routes.
 *
 * POST /api/acx-check
 *   Accepts an audio file upload, returns 202 { checkId } immediately.
 *   Analysis runs in the background; poll the status endpoint to retrieve results.
 *
 * GET /api/acx-check-jobs/:checkId
 *   Returns job status: { status: 'processing'|'done'|'error', ... }
 *   When done: { status: 'done', report: <compliance report> }
 *
 * Reuses the existing in-memory job store. Analysis-only — no audio is written
 * to outputPath, so the download endpoint is not needed for this route.
 */

import { Router } from 'express'
import multer     from 'multer'
import path       from 'path'
import { unlink } from 'fs/promises'
import { analyzeAudioForAcx }                            from '../pipeline/acxAnalysis.js'
import { createJob, completeJob, failJob, getJob, setJobProgress } from '../lib/jobStore.js'

const router = Router()

const upload = multer({
  dest:   path.resolve(import.meta.dirname, '..', 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
})

const SUPPORTED_EXT = new Set([
  '.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac',
])

// ── Submit ────────────────────────────────────────────────────────────────────

router.post('/acx-check', upload.single('file'), async (req, res) => {
  const uploadedPath = req.file?.path
  let jobAccepted = false

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' })
    }

    const ext = path.extname(req.file.originalname).toLowerCase()
    if (!SUPPORTED_EXT.has(ext)) {
      return res.status(400).json({
        error: `Unsupported format: ${ext}. Accepted: ${[...SUPPORTED_EXT].join(', ')}`,
      })
    }

    const checkId = createJob()
    jobAccepted   = true

    console.log(`ACX check ${checkId} accepted: ${req.file.originalname}`)
    res.status(202).json({ checkId })

    // Background analysis
    const startTime = Date.now()
    setJobProgress(checkId, 'Decoding audio…')

    Promise.resolve()
      .then(async () => {
        setJobProgress(checkId, 'Measuring loudness and noise floor…')
        return analyzeAudioForAcx(uploadedPath, req.file.originalname)
      })
      .then(report => {
        completeJob(checkId, { report, peaks: null, outputPath: null })
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
        const cert    = report.acx_certification?.certificate ?? 'n/a'
        console.log(`ACX check ${checkId} done in ${elapsed}s: ${cert} — ${req.file.originalname}`)
      })
      .catch(err => {
        failJob(checkId, err.message)
        console.error(`ACX check ${checkId} failed:`, err)
      })
      .finally(() => {
        unlink(uploadedPath).catch(() => {})
      })

  } catch (err) {
    if (!res.headersSent) {
      res.status(400).json({ error: err.message })
    }
  } finally {
    if (!jobAccepted && uploadedPath) {
      await unlink(uploadedPath).catch(() => {})
    }
  }
})

// ── Poll ──────────────────────────────────────────────────────────────────────

router.get('/acx-check-jobs/:checkId', (req, res) => {
  const job = getJob(req.params.checkId)
  if (!job) {
    return res.status(404).json({ error: 'Check not found or expired (jobs expire after 1 hour)' })
  }

  if (job.status === 'processing') {
    return res.json({ status: 'processing', progress: job.progress })
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error })
  }
  // status === 'done'
  return res.json({ status: 'done', report: job.report })
})

export { router as acxCheckRoute }
