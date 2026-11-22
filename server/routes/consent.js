/**
 * Ad consent (src/platform/consent.js):
 *
 *   GET  /api/consent/region → { country, model }
 *     Which consent model the visitor gets, from Cloudflare's CF-IPCountry
 *     header ("IP Geolocation" must be on for the API hostname — it is by
 *     default). No header, XX or T1 → country null, model 'opt-in': an unknown
 *     visitor is treated as one who must be asked.
 *
 *   POST /api/consent { v, ads, at, id, model, source, page } → 204
 *     Writes ONE `{"evt":"consent",…}` log line per choice — the record that
 *     shows who consented to what, and when (GDPR art. 7(1)). The id is the
 *     browser's anonymous consent id; NO IP, user agent or account is written,
 *     and the country is the region lookup's, not stored with the IP.
 *     A malformed body is 400 and logs nothing.
 *
 * The log goes to stdout with the request log; ship it somewhere durable
 * (Coolify's log drain) and keep it as long as the consents it proves are in
 * use — 12 months past the last one, at least.
 */
import { Router } from 'express'
import { consentModelFor, normalizeCountry } from '../../src/platform/consentRegions.js'

const SOURCES = new Set(['banner', 'settings', 'gpc'])
const MODELS = new Set(['opt-in', 'opt-out'])

/** The logged entry, or null when the body is not a consent record. Exported for tests. */
export function parseConsentBody(body, { now = Date.now() } = {}) {
  if (typeof body !== 'object' || body === null) return null
  const { v, ads, at, id, model, source, page } = body
  if (!Number.isInteger(v) || v < 1 || v > 1000) return null
  if (typeof ads !== 'boolean') return null
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return null
  if (!SOURCES.has(source)) return null
  if (model != null && !MODELS.has(model)) return null
  // The browser's clock is only informative; the server's time is the record.
  const clientAt = Number.isFinite(at) && Math.abs(at - now) < 7 * 24 * 3600e3 ? at : null
  const path = typeof page === 'string' && page.startsWith('/') ? page.slice(0, 200) : null
  return { v, ads, id, model: model ?? null, source, page: path, clientAt }
}

export function consentRoute({ log = line => console.log(line), now = Date.now } = {}) {
  const router = Router()

  router.get('/consent/region', (req, res) => {
    const country = normalizeCountry(req.get('cf-ipcountry'))
    res.set('Cache-Control', 'no-store')
    res.json({ country, model: consentModelFor(country) })
  })

  router.post('/consent', (req, res) => {
    const entry = parseConsentBody(req.body, { now: now() })
    if (!entry) return res.status(400).json({ error: 'Invalid consent record', code: 'invalid_consent' })
    const country = normalizeCountry(req.get('cf-ipcountry'))
    log(JSON.stringify({ evt: 'consent', ts: new Date(now()).toISOString(), ...entry, country }))
    res.status(204).end()
  })

  return router
}
