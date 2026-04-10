/**
 * In-memory async job store.
 *
 * Jobs are created when a processing request is accepted (202) and updated
 * by the background pipeline task. Completed jobs hold the output file path
 * on disk until the client downloads the audio, after which the file is
 * deleted. Jobs that are never retrieved expire after JOB_TTL_MS.
 *
 * This is intentionally simple: no persistence, no Redis. A server restart
 * loses all in-progress jobs. That is acceptable — the client will see a 404
 * on the next poll and surface an error to the user.
 */

import { randomUUID } from 'crypto'
import { unlink }     from 'fs/promises'

// Jobs expire 1 hour after creation whether retrieved or not.
const JOB_TTL_MS      = 60 * 60 * 1000
// Cleanup runs every 5 minutes.
const CLEANUP_INTERVAL = 5 * 60 * 1000

/** @type {Map<string, Job>} */
const jobs = new Map()

/**
 * @typedef {'processing'|'done'|'error'} JobStatus
 *
 * @typedef {Object} Job
 * @property {JobStatus} status
 * @property {string|null} progress  - Human-readable stage description
 * @property {string|null} error     - Error message when status === 'error'
 * @property {object|null} report    - Processing report when status === 'done'
 * @property {object[]|null} peaks   - Peak data when status === 'done'
 * @property {string|null} outputPath - Path to processed audio file on disk
 * @property {number} createdAt
 */

/**
 * Create a new job and return its ID.
 * @returns {string} jobId (UUID)
 */
export function createJob() {
  const jobId = randomUUID()
  jobs.set(jobId, {
    status:     'processing',
    progress:   null,
    error:      null,
    report:     null,
    peaks:      null,
    outputPath: null,
    createdAt:  Date.now(),
  })
  return jobId
}

/**
 * Retrieve a job by ID without modifying it.
 * @param {string} jobId
 * @returns {Job|null}
 */
export function getJob(jobId) {
  return jobs.get(jobId) ?? null
}

/**
 * Mark a job as successfully completed.
 * @param {string} jobId
 * @param {{ report: object, peaks: object[], outputPath: string }} result
 */
export function completeJob(jobId, { report, peaks, outputPath }) {
  const job = jobs.get(jobId)
  if (!job) return
  Object.assign(job, { status: 'done', report, peaks, outputPath })
}

/**
 * Mark a job as failed.
 * @param {string} jobId
 * @param {string} message
 */
export function failJob(jobId, message) {
  const job = jobs.get(jobId)
  if (!job) return
  Object.assign(job, { status: 'error', error: message })
}

/**
 * Update a job's progress message (optional — used for stage-level feedback).
 * @param {string} jobId
 * @param {string} progress
 */
export function setJobProgress(jobId, progress) {
  const job = jobs.get(jobId)
  if (job) job.progress = progress
}

// ── TTL cleanup ───────────────────────────────────────────────────────────────

async function cleanExpiredJobs() {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      if (job.outputPath) await unlink(job.outputPath).catch(() => {})
      jobs.delete(id)
    }
  }
}

// Unref so the interval doesn't prevent Node from exiting cleanly.
const cleanupTimer = setInterval(cleanExpiredJobs, CLEANUP_INTERVAL)
if (cleanupTimer.unref) cleanupTimer.unref()
