/**
 * POST /api/process — Submit an audio processing job.
 *
 * Accepts a multipart upload with:
 *   - file: audio file (WAV, MP3, FLAC, etc.)
 *   - preset: preset ID string
 *   - output_profile: output profile ID string (also accepts legacy 'compliance' field)
 *
 * Returns 202 { jobId } immediately. The pipeline runs in the background,
 * once the job queue (lib/jobQueue.js) has a slot for it. Poll
 * GET /api/jobs/:jobId for status, then GET /api/jobs/:jobId/download
 * to retrieve the processed audio once status === 'done'.
 *
 * Refusals, in the order they are checked:
 *   429 / 503  the caller or the server is at its job limit — checked BEFORE
 *              the upload is read, so a refused request costs no disk
 *   402        `mastering` entitlement: signed out and longer than the free
 *              preview (lib/entitlements.js)
 *   400        invalid preset, profile or file type
 */

import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import { unlink } from 'fs/promises'
import { processAudio } from '../pipeline/index.js'
import { PRESETS, OUTPUT_PROFILES, resolveOutputProfileId } from '../presets.js'
import { createJob, completeJob, failJob, setJobProgress, setJobQueuePosition } from '../lib/jobStore.js'
import { openGate } from '../lib/entitlements.js'
import { optionalAuth } from '../lib/auth.js'
import { createJobQueue, clientOf, sendRefusal } from '../lib/jobQueue.js'

const upload = multer({
  dest: path.resolve(import.meta.dirname, '..', 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
})

const SUPPORTED_EXTENSIONS = new Set([
  '.wav', '.mp3', '.flac', '.aiff', '.aif', '.m4a', '.aac', '.ogg',
])

/**
 * @param {object}   [deps]
 * @param {Function} [deps.gate]    entitlement gate factory (lib/entitlements.js);
 *                                  the default lets every request through
 * @param {Function} [deps.verify]  access-token verifier, so the job limit can
 *                                  count per account; null counts per IP
 * @param {object}   [deps.queue]   job queue (lib/jobQueue.js)
 * @param {object}   [deps.usage]   usage recorder (lib/usage.js); the row is
 *                                  written when the JOB ends, not the request
 */
export function createProcessRoute({ gate = openGate, verify = null, queue = createJobQueue(), usage = null } = {}) {
  const router = Router()

  // Refuse at the limit before multer reads the body.
  const admit = (req, res, next) => {
    const refused = queue.refusal(clientOf(req))
    if (refused) return sendRefusal(res, refused)
    next()
  }

  // gate.signIn lets signed-out callers through (mastering's preview is open
  // to them) but refuses a blocked account before the upload.
  const mastering = () => 'mastering'
  router.post('/process', optionalAuth(verify), gate.signIn(mastering), admit, upload.single('file'), gate(mastering), async (req, res) => {
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
        presetOverrides.voiceFixerMode    != null && `voicefixer_mode=${presetOverrides.voiceFixerMode}`,
      ].filter(Boolean).join(' ')

      // --- Accept job, return immediately ---
      // The pipeline runs in the background. Cloudflare's 100 s proxy timeout
      // only applies to the initial upload request, which now completes well
      // within a few seconds. The client polls /api/jobs/:jobId for progress.
      //
      // Re-check the limit: other uploads may have been admitted while this one
      // streamed in. Nothing awaits between here and submit(), so it cannot race.
      const client = clientOf(req)
      const refused = queue.refusal(client)
      if (refused) return sendRefusal(res, refused)

      const jobId = createJob()
      let startTime = null
      // The request ends at the 202; the usage row describes the job, so it is
      // written here when the job ends rather than through trackWork.
      const recordUsage = outcome => usage?.record({
        userId: req.user?.id ?? null,
        ip: req.ip,
        feature: 'mastering',
        mode: req.entitlement?.mode ?? null,
        audioSeconds: req.audioSeconds,
        uploadBytes: req.file.size,
        outcome,
        durationMs: startTime == null ? null : Date.now() - startTime,
      })
      const pipeline = queue.submit(client, () => {
        startTime = Date.now()
        setJobQueuePosition(jobId, null)
        setJobProgress(jobId, null)
        return processAudio(uploadedPath, req.file.originalname, preset, outputProfile, presetOverrides)
      }, {
        onPosition: n => {
          setJobQueuePosition(jobId, n)
          setJobProgress(jobId, n === 1 ? 'Waiting in line (next up)' : `Waiting in line (${n - 1} ahead of you)`)
        },
      })
      jobAccepted = true

      const { running, queued } = queue.stats()
      console.log(`Job ${jobId} accepted: ${req.file.originalname} | preset=${preset} output_profile=${outputProfile}${overrideSummary ? ` ${overrideSummary}` : ''} | ${client} | running=${running} queued=${queued}`)
      res.status(202).json({ jobId })

      // --- Background pipeline ---
      pipeline
        .then(({ outputPath, report, peaks }) => {
          completeJob(jobId, { report, peaks, outputPath })
          recordUsage('ok')
          const elapsed    = ((Date.now() - startTime) / 1000).toFixed(1)
          const certStatus = report.acx_certification
            ? `acx=${report.acx_certification.certificate}`
            : 'no-cert'
          console.log(`Job ${jobId} done in ${elapsed}s: ${req.file.originalname} | ${certStatus}`)
        })
        .catch(err => {
          failJob(jobId, err.message)
          recordUsage('error')
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

  return router
}
