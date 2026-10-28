/**
 * One structured log line per server-processing request, and the usage row
 * for it.
 *
 * Mounted ahead of the rate limiters on /api/process, /api/spot and
 * /api/analyze, so every outcome is logged — served, previewed, and each kind
 * of refusal (rate limit, sign-in, plan, job limit, block). The line is JSON
 * on stdout, one object per line, for whatever collects the process's output:
 *
 *   {"evt":"api","t":"…","route":"/api/analyze/vad","user":"<uuid>"|null,
 *    "ip":"…","status":200,"code":null,"feature":"autoLevel","mode":"preview",
 *    "bytes":123456,"audio_s":28.4,"ms":812}
 *
 * `code` is the refusal code from the response body (`sign_in_required`,
 * `upgrade_required`, `too_many_jobs`, …) when there is one.
 *
 * The usage row describes WORK, not the response: a route hands its work to
 * `trackWork(res, promise)` and the row is written when that promise settles —
 * 'ok' or 'error', timed from the request's start. A request that never
 * reached the work (any refusal, 4xx or 503) writes no row, and a client that
 * hangs up mid-render does not turn a render still running into an 'ok' at the
 * moment of the disconnect. A route whose work outlives the request
 * (mastering's 202) records its own row when the job ends instead.
 *
 * Fields the line reads, set by the middleware after it:
 *   req.user          lib/auth.js / the entitlement gate
 *   req.feature       the entitlement gate
 *   req.entitlement   the entitlement gate ({ plan, mode })
 *   req.audioSeconds  the entitlement gate (decoded duration)
 *   req.file          multer
 */

export function requestLog({ usage = null, log = line => console.log(line), now = Date.now } = {}) {
  return (req, res, next) => {
    const started = now()
    let code = null

    // Capture the refusal code without changing what is sent.
    const json = res.json.bind(res)
    res.json = body => {
      if (res.statusCode >= 400 && body && typeof body.code === 'string') code = body.code
      return json(body)
    }

    res.locals.trackWork = promise => {
      // Settled work is recorded even if the response is long gone.
      Promise.resolve(promise).then(() => 'ok', () => 'error').then(outcome => {
        if (!usage || !req.feature) return
        usage.record({
          userId: req.user?.id ?? null,
          ip: req.ip ?? null,
          feature: req.feature,
          mode: req.entitlement?.mode ?? null,
          audioSeconds: req.audioSeconds,
          uploadBytes: req.file?.size,
          outcome,
          durationMs: now() - started,
        })
      })
      return promise
    }

    let done = false
    const finish = () => {
      if (done) return
      done = true
      const status = res.statusCode
      const entry = {
        evt: 'api',
        t: new Date(started).toISOString(),
        route: (req.originalUrl ?? req.url ?? '').split('?')[0],
        user: req.user?.id ?? null,
        ip: req.ip ?? null,
        status,
        code,
        feature: req.feature ?? null,
        mode: req.entitlement?.mode ?? null,
        bytes: req.file?.size ?? contentLength(req),
        audio_s: Number.isFinite(req.audioSeconds) ? Math.round(req.audioSeconds * 10) / 10 : null,
        ms: now() - started,
      }
      if (!res.writableFinished) entry.aborted = true
      log(JSON.stringify(entry))
    }
    res.once('finish', finish)
    res.once('close', finish)
    next()
  }
}

function contentLength(req) {
  const n = Number(req.headers?.['content-length'])
  return Number.isFinite(n) ? n : null
}

/**
 * Hand a route's work to the request log so its usage row is written when the
 * work settles. Returns the promise unchanged; a no-op without the log.
 */
export function trackWork(res, promise) {
  return res.locals?.trackWork ? res.locals.trackWork(promise) : promise
}
