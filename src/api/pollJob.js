/**
 * Polling for an accepted mastering job (POST /api/process → 202 { jobId }).
 * Its own module, free of browser-only imports, so it runs under node --test.
 */

const POLL_INTERVAL_MS = 3000       // 3 s between status checks
const MAX_POLL_ATTEMPTS = 400       // 400 × 3 s = 20 min of processing
// Time a job spends waiting for a server slot (`queuePosition` set) does not
// count against the processing budget above — under load the line alone could
// use it up, and the client would abandon a job the server then finishes. It
// has its own, longer cap.
const MAX_QUEUE_POLLS = 1200        // 1200 × 3 s = 60 min in line

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Poll a job's status until it is done; resolves with the final status body.
 * Throws when the job fails, or when either budget runs out: processing polls
 * (`MAX_POLL_ATTEMPTS`) and, separately, polls spent waiting in line
 * (`queuePosition` set, `MAX_QUEUE_POLLS`).
 */
export async function pollJob({
  fetchStatus, onProgress, wait = sleep,
  maxPolls = MAX_POLL_ATTEMPTS, maxQueuePolls = MAX_QUEUE_POLLS,
}) {
  let processingPolls = 0
  let queuePolls = 0
  while (processingPolls < maxPolls && queuePolls < maxQueuePolls) {
    await wait(POLL_INTERVAL_MS)
    const job = await fetchStatus()
    if (job.status === 'done') return job
    if (job.status === 'error') throw new Error(job.error || 'Processing failed on server')
    if (onProgress && job.progress) onProgress(job.progress)
    if (job.queuePosition != null) queuePolls++
    else processingPolls++
  }
  throw new Error(queuePolls >= maxQueuePolls
    ? 'The server is busy and the job did not start — please try again later'
    : 'Processing timed out — please try again with a shorter file')
}
