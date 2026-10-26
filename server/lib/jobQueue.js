/**
 * Admission control for preset-chain jobs.
 *
 * Without it every accepted upload starts its pipeline at once, so a burst of
 * requests (one abuser, or a launch-day spike) runs that many DF3 / Demucs
 * chains side by side and slows every job on the box to a crawl. The queue
 * caps three things:
 *
 *   concurrency   pipelines running at once — the rest wait their turn
 *   maxQueued     jobs waiting — beyond this the server is BUSY (503)
 *   maxPerClient  jobs one caller may have queued or running — beyond this
 *                 the caller is told to wait for their own jobs (429)
 *
 * A "client" is whatever the route names it: the account id when signed in,
 * the IP otherwise.
 *
 * In memory, like the job store: a restart forgets the queue along with the
 * jobs in it.
 *
 * Environment (read by `readJobQueueConfig`):
 *   MAX_CONCURRENT_JOBS   default 2
 *   MAX_QUEUED_JOBS       default 10
 *   MAX_JOBS_PER_CLIENT   default 2
 */

export class QueueRefusal extends Error {
  /**
   * @param {'server_busy'|'too_many_jobs'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
    this.status = code === 'server_busy' ? 503 : 429
  }
}

function readCount(name, fallback, min) {
  const n = parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function readJobQueueConfig() {
  return {
    concurrency:  readCount('MAX_CONCURRENT_JOBS', 2, 1),
    maxQueued:    readCount('MAX_QUEUED_JOBS', 10, 0),
    maxPerClient: readCount('MAX_JOBS_PER_CLIENT', 2, 1),
  }
}

export function createJobQueue({ concurrency = 2, maxQueued = 10, maxPerClient = 2 } = {}) {
  /** @type {{ client: string, run: Function, onPosition?: Function, resolve: Function, reject: Function }[]} */
  const waiting = []
  const perClient = new Map()  // client -> jobs queued + running
  let running = 0

  /** Why `client` cannot submit now, or null if it can. Does not reserve anything. */
  function refusal(client) {
    if ((perClient.get(client) ?? 0) >= maxPerClient) {
      return new QueueRefusal(
        'too_many_jobs',
        `You already have ${maxPerClient} mastering job${maxPerClient === 1 ? '' : 's'} in progress — wait for one to finish.`,
      )
    }
    if (running >= concurrency && waiting.length >= maxQueued) {
      return new QueueRefusal('server_busy', 'The server is busy — please try again in a few minutes.')
    }
    return null
  }

  function release(client) {
    const n = (perClient.get(client) ?? 1) - 1
    if (n > 0) perClient.set(client, n)
    else perClient.delete(client)
  }

  function start(task) {
    running++
    Promise.resolve()
      .then(() => task.run())
      .then(task.resolve, task.reject)
      .finally(() => {
        running--
        release(task.client)
        drain()
      })
  }

  function drain() {
    while (running < concurrency && waiting.length) start(waiting.shift())
    waiting.forEach((task, i) => task.onPosition?.(i + 1))
  }

  /**
   * Run `run()` when a slot frees up. Throws a QueueRefusal synchronously if
   * the caller or the server is at its limit; otherwise returns a promise of
   * `run`'s result. `onPosition(n)` is called with the 1-based place in line
   * whenever it changes while the task waits (never if it starts at once).
   */
  function submit(client, run, { onPosition } = {}) {
    const refused = refusal(client)
    if (refused) throw refused
    perClient.set(client, (perClient.get(client) ?? 0) + 1)
    return new Promise((resolve, reject) => {
      const task = { client, run, onPosition, resolve, reject }
      if (running < concurrency) {
        start(task)
      } else {
        waiting.push(task)
        onPosition?.(waiting.length)
      }
    })
  }

  function stats() {
    return { running, queued: waiting.length, concurrency, maxQueued, maxPerClient }
  }

  return { refusal, submit, stats }
}
