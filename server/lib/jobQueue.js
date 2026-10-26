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

/**
 * The limit shared by the synchronous server-processing routes (/api/spot,
 * /api/analyze). They never wait in line — a request held behind others would
 * run into the proxy's timeout — so the queue refuses as soon as it is full.
 *
 *   MAX_CONCURRENT_ANALYSES    default 4
 *   MAX_ANALYSES_PER_CLIENT    default 2
 */
export function readRequestLimitConfig() {
  return {
    concurrency:  readCount('MAX_CONCURRENT_ANALYSES', 4, 1),
    maxQueued:    0,
    maxPerClient: readCount('MAX_ANALYSES_PER_CLIENT', 2, 1),
    messages: {
      tooMany: n => `You already have ${n} server analys${n === 1 ? 'is' : 'es'} running — wait for one to finish.`,
      busy: 'The server is busy — please try again in a minute.',
    },
  }
}

const DEFAULT_MESSAGES = {
  tooMany: n => `You already have ${n} mastering job${n === 1 ? '' : 's'} in progress — wait for one to finish.`,
  busy: 'The server is busy — please try again in a few minutes.',
}

/**
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {number} [opts.maxQueued]     0 = never wait: refuse once every slot is busy
 * @param {number} [opts.maxPerClient]
 * @param {{ tooMany?: (n: number) => string, busy?: string }} [opts.messages]
 */
export function createJobQueue({ concurrency = 2, maxQueued = 10, maxPerClient = 2, messages = {} } = {}) {
  const text = { ...DEFAULT_MESSAGES, ...messages }
  /** @type {{ client: string, run: Function, onPosition?: Function, resolve: Function, reject: Function }[]} */
  const waiting = []
  const perClient = new Map()  // client -> jobs queued + running
  let running = 0

  /** Why `client` cannot submit now, or null if it can. Does not reserve anything. */
  function refusal(client) {
    if ((perClient.get(client) ?? 0) >= maxPerClient) {
      return new QueueRefusal('too_many_jobs', text.tooMany(maxPerClient))
    }
    if (running >= concurrency && waiting.length >= maxQueued) {
      return new QueueRefusal('server_busy', text.busy)
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

/** Who a request counts against: the account when signed in, else the IP. */
export function clientOf(req) {
  return req.user?.id ? `user:${req.user.id}` : `ip:${req.ip}`
}

export function sendRefusal(res, refusal) {
  if (refusal.status === 503) res.set('Retry-After', '60')
  return res.status(refusal.status).json({ error: refusal.message, code: refusal.code })
}

/**
 * Middleware for SYNCHRONOUS routes: take a slot in `queue` for the whole life
 * of the request — upload, processing and response — or refuse it at once
 * (build the queue with `maxQueued: 0`; a request cannot wait in line behind a
 * proxy timeout). Runs before multer, after anything that sets `req.user`.
 *
 * The route handler CLAIMS the slot (`res.locals.slot.claim()`, which returns
 * the release) and releases it when its work is done — not when the client
 * hangs up, or a client could abort mid-render and start another while the
 * first still holds a worker. A request refused before the handler runs (a
 * multer error, the plan gate) releases when its response closes.
 */
export function holdSlot(queue) {
  return (req, res, next) => {
    let release
    const done = new Promise(resolve => { release = resolve })
    try {
      queue.submit(clientOf(req), () => done).catch(() => {})
    } catch (err) {
      if (err instanceof QueueRefusal) return sendRefusal(res, err)
      throw err
    }
    let claimed = false
    res.locals.slot = {
      claim() {
        claimed = true
        return release
      },
    }
    res.once('close', () => { if (!claimed) release() })
    next()
  }
}
