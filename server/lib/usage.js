/**
 * Who used server processing, and who is not allowed to.
 *
 *   createUsageRecorder  writes one `usage_events` row per served request and
 *                        prunes rows past the retention window.
 *   createBlockResolver  userId -> blocked?, from `profiles.blocked_at`,
 *                        cached briefly like the plan resolver.
 *
 * Both take the service-role client (lib/supabaseAdmin.js). Without one —
 * accounts not configured — the recorder records nothing and nobody is
 * blocked, matching the pre-accounts server.
 *
 * Environment:
 *   USAGE_RETENTION_DAYS  days of usage rows to keep (default 90; 0 keeps all)
 */

const DAY_MS = 24 * 60 * 60 * 1000

export function readUsageRetentionDays() {
  const raw = process.env.USAGE_RETENTION_DAYS
  if (raw == null || raw === '') return 90
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 90
}

/**
 * @param {object|null} admin  Supabase service-role client
 */
export function createUsageRecorder(admin, { now = Date.now } = {}) {
  /**
   * Fire and forget. A failed write is logged and dropped: losing a usage row
   * is better than failing (or slowing) the request it describes.
   *
   * @param {{ userId?: string|null, ip?: string|null, feature: string,
   *           mode?: string|null, audioSeconds?: number|null,
   *           uploadBytes?: number|null, outcome: 'ok'|'error',
   *           durationMs?: number|null }} event
   * @returns {Promise<void>}
   */
  async function record(event) {
    if (!admin || !event?.feature) return
    const row = {
      user_id: event.userId ?? null,
      ip: event.ip || null,
      feature: event.feature,
      mode: event.mode ?? null,
      audio_seconds: finiteOrNull(event.audioSeconds),
      upload_bytes: Number.isFinite(event.uploadBytes) ? Math.round(event.uploadBytes) : null,
      outcome: event.outcome,
      duration_ms: Number.isFinite(event.durationMs) ? Math.round(event.durationMs) : null,
    }
    try {
      const { error } = await admin.from('usage_events').insert(row)
      if (error) console.error('[usage] insert failed:', error.message)
    } catch (err) {
      console.error('[usage] insert failed:', err?.message ?? err)
    }
  }

  /** Delete rows older than `days`. Returns nothing; errors are logged. */
  async function prune(days) {
    if (!admin || !(days > 0)) return
    const cutoff = new Date(now() - days * DAY_MS).toISOString()
    try {
      const { error } = await admin.from('usage_events').delete().lt('created_at', cutoff)
      if (error) console.error('[usage] prune failed:', error.message)
    } catch (err) {
      console.error('[usage] prune failed:', err?.message ?? err)
    }
  }

  /** Prune now and then once a day. Returns a stop function. */
  function startPruning(days) {
    if (!admin || !(days > 0)) return () => {}
    prune(days)
    const timer = setInterval(() => prune(days), DAY_MS)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  return { record, prune, startPruning, enabled: !!admin }
}

function finiteOrNull(n) {
  return Number.isFinite(n) ? n : null
}

/**
 * userId -> boolean, cached for `ttlMs` — a block lands within a minute
 * without a database read on every request.
 *
 * A lookup that FAILS answers "not blocked": a database hiccup must not lock
 * every user out. Blocking is an operator's tool against one account, not a
 * security boundary that has to fail closed.
 */
export function createBlockResolver(admin, { ttlMs = 60_000, now = Date.now } = {}) {
  const cache = new Map()
  async function isBlocked(userId) {
    if (!admin || !userId) return false
    const hit = cache.get(userId)
    if (hit && now() - hit.at < ttlMs) return hit.blocked
    try {
      const { data, error } = await admin
        .from('profiles')
        .select('blocked_at')
        .eq('id', userId)
        .maybeSingle()
      if (error) throw new Error(error.message)
      const blocked = data?.blocked_at != null
      cache.set(userId, { blocked, at: now() })
      if (cache.size > 10_000) cache.delete(cache.keys().next().value)
      return blocked
    } catch (err) {
      console.error('[usage] block lookup failed:', err?.message ?? err)
      return false
    }
  }
  return isBlocked
}
