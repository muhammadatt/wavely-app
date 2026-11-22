/**
 * Consent for advertising pixels (Meta Pixel, Google Ads).
 *
 * The rules this module exists to keep:
 *
 *   - NOTHING TRACKS BEFORE A YES where a yes is required. No vendor script,
 *     no `fbq('init')`, no Google tag is even requested until `ads` is granted
 *     (Google Consent Mode's BASIC mode — the tag is not loaded at all while
 *     consent is denied; ADVANCED mode, which loads it and sends cookieless
 *     pings, is deliberately not used).
 *   - Where no vendor is configured the whole thing is INERT: no banner, no
 *     region lookup, no storage. Asking for consent to nothing is noise.
 *   - Global Privacy Control is a refusal, recorded without asking.
 *   - Withdrawing is as easy as granting: `reopen()` (the footer's "Your privacy
 *     choices") brings the same two-button bar back.
 *   - A choice is remembered for 12 months (granted) or 6 (refused — a "no"
 *     should not be re-asked every visit, but nor kept forever), and expires
 *     at once when `CONSENT_VERSION` moves. BUMP IT WHENEVER A VENDOR OR
 *     PURPOSE IS ADDED: a yes covers only what the visitor was told about.
 *   - Every choice is logged to the server (`POST /api/consent`) with an
 *     anonymous id, so it can be shown who consented to what and when (GDPR
 *     art. 7(1)). No IP or account is attached.
 *
 * The choice itself lives in localStorage. Remembering a refusal needs no
 * consent (it is strictly necessary to honour it).
 *
 * The logic (`decide`, `readRecord`, `createConsentManager`) is pure and
 * injectable so it is testable in Node; `consent` at the bottom is the
 * browser's instance, configured from `VITE_META_PIXEL_ID` /
 * `VITE_GOOGLE_ADS_ID`.
 */
import { consentModelFor } from './consentRegions.js'
import { applyAdPixels } from './adPixels.js'

export const CONSENT_VERSION = 1
export const CONSENT_KEY = 'wavely:consent'

const DAY_MS = 24 * 60 * 60 * 1000
export const GRANTED_TTL_MS = 365 * DAY_MS
export const REFUSED_TTL_MS = 182 * DAY_MS

/** Where a recorded choice came from. */
export const CONSENT_SOURCES = ['banner', 'settings', 'gpc']

/** The stored record, or null when absent / unreadable / malformed. */
export function readRecord(storage) {
  let raw
  try { raw = storage?.getItem(CONSENT_KEY) } catch { return null }
  if (!raw) return null
  try {
    const r = JSON.parse(raw)
    if (typeof r !== 'object' || r === null) return null
    if (typeof r.ads !== 'boolean' || !Number.isFinite(r.at) || !Number.isInteger(r.v)) return null
    return r
  } catch { return null }
}

export function writeRecord(storage, record) {
  try { storage?.setItem(CONSENT_KEY, JSON.stringify(record)) } catch { /* private mode: the choice holds for this page only */ }
}

/** A record still answers the question: same version, not expired. */
export function isCurrent(record, now) {
  if (!record || record.v !== CONSENT_VERSION) return false
  const ttl = record.ads ? GRANTED_TTL_MS : REFUSED_TTL_MS
  return now - record.at >= 0 && now - record.at < ttl
}

/**
 * What to do on page load.
 * @returns {{ ads: boolean, ask: boolean, recordGpc: boolean }}
 */
export function decide({ record, model, gpc, now }) {
  if (isCurrent(record, now)) return { ads: record.ads, ask: false, recordGpc: false }
  if (gpc) return { ads: false, ask: false, recordGpc: true }
  if (model === 'opt-out') return { ads: true, ask: false, recordGpc: false }
  return { ads: false, ask: true, recordGpc: false }
}

function newId() {
  try { return globalThis.crypto.randomUUID() } catch { return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` }
}

/**
 * @param {object}   o
 * @param {object}   o.vendors       `{ metaPixelId?, googleAdsId? }` — none set = inert
 * @param {Storage}  [o.storage]
 * @param {() => number} [o.now]
 * @param {boolean}  [o.gpc]         navigator.globalPrivacyControl
 * @param {() => Promise<string>} [o.fetchModel]  resolves 'opt-in' | 'opt-out'
 * @param {(ads: boolean, vendors: object) => void} [o.apply]  load / revoke the pixels
 * @param {(entry: object) => void} [o.log]       send a choice to the server
 */
export function createConsentManager({
  vendors = {}, storage = null, now = Date.now, gpc = false,
  fetchModel = async () => 'opt-in', apply = () => {}, log = () => {},
} = {}) {
  const configured = Boolean(vendors.metaPixelId || vendors.googleAdsId)
  const state = { ready: false, inert: !configured, ads: false, ask: false, reopened: false, model: null }
  const listeners = new Set()
  let id = null
  let applied = false

  const emit = () => { for (const fn of listeners) fn({ ...state }) }

  function setAds(ads) {
    // Revoking only matters once something was loaded; a refusal on a fresh
    // page must not touch any vendor at all.
    if (ads || applied) apply(ads, vendors)
    applied = applied || ads
    state.ads = ads
  }

  function record(ads, source) {
    const rec = { v: CONSENT_VERSION, ads, at: now(), id: id ?? (id = newId()), model: state.model, source }
    writeRecord(storage, rec)
    try { log(rec) } catch { /* logging never blocks the choice */ }
  }

  return {
    get state() { return { ...state } },

    subscribe(fn) { listeners.add(fn); fn({ ...state }); return () => listeners.delete(fn) },

    async start() {
      if (!configured) { state.ready = true; emit(); return }
      const stored = readRecord(storage)
      id = stored?.id ?? null
      let model = stored?.model ?? null
      // The region lookup is only needed when the stored record cannot answer.
      if (!isCurrent(stored, now()) && !gpc) {
        try { model = await fetchModel() } catch { model = 'opt-in' }
        if (model !== 'opt-out') model = 'opt-in'
      }
      state.model = model
      const d = decide({ record: stored, model, gpc, now: now() })
      if (d.recordGpc) record(false, 'gpc')
      setAds(d.ads)
      state.ask = d.ask
      state.ready = true
      emit()
    },

    /** The visitor's answer, from the bar (or, after `reopen()`, from settings). */
    choose(ads) {
      if (!configured || !state.ready) return
      record(Boolean(ads), state.reopened ? 'settings' : 'banner')
      setAds(Boolean(ads))
      state.ask = false
      state.reopened = false
      emit()
    },

    /** "Your privacy choices": show the bar again so the answer can change. */
    reopen() {
      if (!configured || !state.ready) return
      state.ask = true
      state.reopened = true
      emit()
    },

    /** Put the bar away after a reopen without changing anything. */
    cancel() {
      if (!state.reopened) return
      state.ask = false
      state.reopened = false
      emit()
    },

    /** Whether the ad pixels may run right now. */
    granted() { return state.ads },
  }
}

// ── The browser's instance ────────────────────────────────────────────────

const env = import.meta.env ?? {}
const API_BASE = env.VITE_API_BASE_URL ?? ''

export const AD_VENDORS = Object.freeze({
  metaPixelId: env.VITE_META_PIXEL_ID || null,
  googleAdsId: env.VITE_GOOGLE_ADS_ID || null,
})

/** Privacy policy the bar's Details links to; the link is hidden when unset. */
export const PRIVACY_URL = env.VITE_PRIVACY_URL || null

async function fetchModel() {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(`${API_BASE}/api/consent/region`, { signal: ctrl.signal, credentials: 'omit' })
    if (!res.ok) return 'opt-in'
    const body = await res.json()
    return body?.model === 'opt-out' ? 'opt-out' : consentModelFor(body?.country)
  } finally { clearTimeout(t) }
}

function logChoice(rec) {
  fetch(`${API_BASE}/api/consent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    keepalive: true,
    body: JSON.stringify({ ...rec, page: location.pathname }),
  }).catch(() => {})
}

const inBrowser = typeof window !== 'undefined'

export const consent = createConsentManager({
  vendors: AD_VENDORS,
  storage: inBrowser ? (() => { try { return window.localStorage } catch { return null } })() : null,
  gpc: inBrowser && navigator.globalPrivacyControl === true,
  fetchModel,
  apply: applyAdPixels,
  log: logChoice,
})
