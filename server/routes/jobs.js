/**
 * Job status and download routes.
 *
 * GET  /api/jobs/:jobId          — poll for processing status
 * GET  /api/jobs/:jobId/download — stream processed audio (once ready)
 *
 * These routes exist to decouple long-running pipeline work from the HTTP
 * request lifecycle. POST /api/process returns a jobId immediately (202);
 * the client polls here until status === 'done', then downloads the audio.
 */

import { Router }         from 'express'
import { createReadStream } from 'fs'
import { unlink }         from 'fs/promises'
import { getJob }         from '../lib/jobStore.js'

const router = Router()

// ── GET /api/jobs/:jobId ──────────────────────────────────────────────────────
// Returns the current job status.
//
// While processing:  { status: 'processing', progress: string|null }
// On success:        { status: 'done', report: object, peaks: object[] }
// On failure:        { status: 'error', error: string }

router.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId)

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' })
  }

  if (job.status === 'processing') {
    return res.json({ status: 'processing', progress: job.progress })
  }

  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error })
  }

  // status === 'done' — return report + peaks; audio is fetched separately
  return res.json({ status: 'done', report: job.report, peaks: job.peaks })
})

// ── GET /api/jobs/:jobId/download ─────────────────────────────────────────────
// Stream the processed audio file to the client.
//
// The file is deleted from disk after the first successful transfer to free
// disk space. This route therefore supports a single successful download per
// completed job. The job record may remain available until TTL expiry so
// status polls can continue to return 'done'.

router.get('/jobs/:jobId/download', async (req, res) => {
  const job = getJob(req.params.jobId)

  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired' })
  }

  if (job.status === 'processing') {
    return res.status(202).json({ error: 'Job still processing — poll /api/jobs/:jobId first' })
  }

  if (job.status === 'error') {
    return res.status(422).json({ error: job.error })
  }

  if (!job.outputPath) {
    return res.status(500).json({ error: 'Output path missing from completed job' })
  }

  res.setHeader('Content-Type', 'audio/wav')
  res.setHeader('Content-Disposition', 'attachment; filename="processed.wav"')
  res.setHeader('Cache-Control', 'no-store')

  const stream = createReadStream(job.outputPath)

  stream.on('error', (err) => {
    // File may have already been deleted (re-download after TTL cleanup)
    if (err.code === 'ENOENT') {
      if (!res.headersSent) {
        res.status(410).json({ error: 'Processed file no longer available — please reprocess' })
      } else {
        res.destroy()
      }
      return
    }
    console.error(`[jobs] Download stream error for ${req.params.jobId}:`, err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Stream error' })
    else res.destroy()
  })

  stream.on('end', () => {
    // Delete file after first successful download to free disk space.
    // The job record remains in the store until TTL expiry so status
    // polls continue to return 'done' correctly.
    unlink(job.outputPath).catch(() => {})
    job.outputPath = null
  })

  stream.pipe(res)
})

export { router as jobsRoute }
