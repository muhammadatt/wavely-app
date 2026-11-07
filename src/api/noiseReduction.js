/**
 * API client for the Noise Reduction plugin (`/api/spot/noise_reduction`).
 *
 * Job-based, unlike the other spot effects: the route answers 202 { jobId }
 * and this polls /api/jobs/:jobId, because DeepFilterNet3 on a chapter-length
 * selection can outlast the proxy's ~100 s timeout (CLAUDE.md, "Async Job
 * Architecture"). Polls faster than the preset chain's 3 s — a few-second
 * selection is done in about that long, and the user is waiting on a modal.
 */

import { renderRegionToBuffer, floatChannelsToWavBlob } from '../audio/processing.js'
import { decodeWav } from '../audio/wavDecode.js'
import { toServerParams } from '../audio/noiseReductionParams.js'
import { serverError } from './serverError.js'
import { uploadAudio, postWithUpload, discardAudioUpload } from './uploadAudio.js'
import { pollJob } from './pollJob.js'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? ''

const POLL_INTERVAL_MS = 1000
// Polls spent processing (30 min) and, separately, polls spent waiting in the
// shared job queue behind mastering jobs (`queuePosition` set, 60 min) — the
// line must not use up the processing budget, or the client would give up on
// a job the server then runs.
const MAX_PROCESSING_POLLS = 30 * 60
const MAX_QUEUE_POLLS = 60 * 60
const CANCEL_CHECK_MS = 250

const CANCELLED = Symbol('cancelled')

/**
 * Denoise [start, end) of `segments` on the server.
 *
 * @param {object}   options
 * @param {Array}    options.segments
 * @param {number}   options.start        seconds
 * @param {number}   options.end          seconds
 * @param {number}   options.sampleRate
 * @param {number}   options.channels
 * @param {object}   options.params       plugin params (Mix is not sent)
 * @param {Function} [options.isCancelled] polled between requests; true stops
 *                                        waiting (the server job runs out)
 * @param {Function} [options.onStage]   called with a short stage name as the
 *                                        request moves: 'upload' (with a
 *                                        percentage), 'denoise' (with the
 *                                        server's progress text, if any),
 *                                        'download'
 * @returns {Promise<{ dry: Float32Array[], wet: Float32Array[], report: object|null } | null>}
 *   `dry` is what was sent, `wet` the server's result fitted to the same length
 *   and channel count; null when cancelled
 */
export async function denoiseRegion({
  segments, start, end, sampleRate, channels, params, isCancelled = () => false,
  onStage = () => {},
}) {
  onStage('upload')
  const dry = renderRegionToBuffer(segments, start, end, sampleRate, channels)

  // Cancel is a poll, so watch it and abort the upload: otherwise the rest of
  // a chapter keeps going up after the user gave up on it.
  const abort = new AbortController()
  const watch = setInterval(() => { if (isCancelled()) abort.abort() }, CANCEL_CHECK_MS)

  let uploadId
  try {
    // A chapter is hundreds of MB of float WAV: it goes up as a resumable
    // upload in chunks under Cloudflare's 100 MB request cap, then the job
    // request names it (src/api/uploadAudio.js). A cancelled upload deletes
    // itself.
    uploadId = await uploadAudio(floatChannelsToWavBlob(dry, sampleRate, channels), {
      filename: 'selection.wav',
      signal: abort.signal,
      onProgress: (sent, total) => onStage('upload', `${Math.round((total ? sent / total : 1) * 100)}%`),
    })
  } catch (err) {
    if (abort.signal.aborted || isCancelled()) return null
    throw err
  } finally {
    clearInterval(watch)
  }
  if (isCancelled()) {
    // Finished, but nobody will use it: give back the caller's upload quota.
    await discardAudioUpload(uploadId)
    return null
  }

  const submit = await postWithUpload('/api/spot/noise_reduction', {
    uploadId, params: JSON.stringify(toServerParams(params)),
  }, 'Noise reduction failed')
  const { jobId } = await submit.json()
  if (isCancelled()) return null
  onStage('denoise', null)

  let job
  try {
    job = await pollJob({
      interval: POLL_INTERVAL_MS,
      maxPolls: MAX_PROCESSING_POLLS,
      maxQueuePolls: MAX_QUEUE_POLLS,
      onProgress: progress => onStage('denoise', progress),
      fetchStatus: async () => {
        if (isCancelled()) throw CANCELLED
        const poll = await fetch(`${API_BASE}/api/jobs/${jobId}`)
        if (!poll.ok) throw await serverError(poll, 'Noise reduction status check failed')
        return poll.json()
      },
    })
  } catch (err) {
    if (err === CANCELLED) return null
    if (/timed out/.test(err?.message)) throw new Error('Noise reduction timed out — try a shorter selection')
    throw err
  }
  if (isCancelled()) return null

  onStage('download')
  const download = await fetch(`${API_BASE}/api/jobs/${jobId}/download`)
  if (!download.ok) throw await serverError(download, 'Noise reduction download failed')
  const decoded = decodeWav(await download.arrayBuffer())
  if (decoded.sampleRate !== sampleRate) {
    throw new Error(`Noise reduction came back at ${decoded.sampleRate} Hz, expected ${sampleRate} Hz`)
  }

  return { dry, wet: fitToDry(decoded.channels, dry), report: job.report ?? null }
}

/**
 * The server length-matches and keeps the channel count; this is the belt to
 * that, so a resampler's off-by-one never moves the splice point.
 */
export function fitToDry(wet, dry) {
  return dry.map((d, ch) => {
    const w = wet[ch] ?? wet[0]
    if (w.length === d.length) return w
    const out = new Float32Array(d.length)
    out.set(w.length > d.length ? w.subarray(0, d.length) : w)
    return out
  })
}
