/**
 * Shared before / after listens (`/s/<id>`) — the rules, with no I/O.
 *
 * A share is the dry audio and the same span through the sender's Plugin
 * Chain, both MP3, plus the chain (the saved-chain params), a title and a
 * note. Storage and its rules: supabase/migrations/20261125000000_shares.sql;
 * the calls: src/api/shares.js; making one: composables/useShareListen.js;
 * the page: src/listen/.
 */

/** Longest span a share may hold (the table's check says the same). */
export const SHARE_MAX_SECONDS = 600
export const SHARE_TITLE_MAX = 80
export const SHARE_NOTE_MAX = 500
/** Both takes, identically: aligned to the sample, and small enough to stream. */
export const SHARE_MP3_BITRATE = 192
export const SHARE_BUCKET = 'shares'

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const SHARE_ID_RE = /^[A-Za-z0-9]{12}$/

/** 12 random base62 characters (~71 bits), unbiased. */
export function newShareId(random = n => crypto.getRandomValues(new Uint8Array(n))) {
  let id = ''
  while (id.length < 12) {
    for (const b of random(16)) {
      // 248 = 4 × 62: reject the top bytes so every character is equally likely.
      if (b < 248 && id.length < 12) id += ID_CHARS[b % 62]
    }
  }
  return id
}

export const isShareId = id => typeof id === 'string' && SHARE_ID_RE.test(id)

/** Object paths of a share's two takes in the bucket. */
export function sharePaths(id) {
  return { off: `${id}/dry.mp3`, on: `${id}/wet.mp3` }
}

/** The listen page for a share. */
export function listenUrl(id, origin) {
  return `${origin.replace(/\/+$/, '')}/s/${id}`
}

/** The editor, opening a share's recording with its chain. */
export function openInEditorUrl(id, origin = '') {
  return `${origin.replace(/\/+$/, '')}/?listen=${id}`
}

/** The share id a listen page's path names (`/s/<id>`, `/s/<id>/`, or `?id=`), or null. */
export function shareIdFromLocation(pathname, search = '') {
  const m = /^\/s\/([A-Za-z0-9]{12})\/?$/.exec(pathname ?? '')
  if (m) return m[1]
  const q = new URLSearchParams(search ?? '').get('id')
  return isShareId(q) ? q : null
}

/** The share id in the editor's `?listen=` query, or null. */
export function listenIdFromSearch(search) {
  const id = new URLSearchParams(search ?? '').get('listen')
  return isShareId(id) ? id : null
}

/** A title and note as the table will take them. */
export function cleanShareText(title, note) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, SHARE_TITLE_MAX)
  const n = String(note ?? '').replace(/\r\n?/g, '\n').trim().slice(0, SHARE_NOTE_MAX)
  return { title: t, note: n }
}

/** A share's default title from the file name: no extension. */
export function defaultShareTitle(fileName) {
  const base = String(fileName ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').trim()
  return (base || 'Before / after').slice(0, SHARE_TITLE_MAX)
}

/**
 * What a share row says, checked — or null. A row comes from the database, but
 * its chain was written by a browser, so the editor treats it like a link
 * (useSharedLink.js) and every plugin re-checks its own settings on load.
 */
export function normalizeShareRow(row) {
  if (!row || typeof row !== 'object' || !isShareId(row.id)) return null
  const { title, note } = cleanShareText(row.title, row.note)
  const slots = Array.isArray(row.chain?.slots) ? row.chain.slots : []
  const seconds = Number(row.seconds)
  if (!title || !(seconds > 0)) return null
  const num = v => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
  return {
    id: row.id,
    title,
    note,
    chain: { slots },
    seconds,
    levelDb: { off: num(row.level_off_db), on: num(row.level_on_db) },
    createdAt: row.created_at ?? null,
  }
}

/**
 * Gated loudness proxy for the player's level match — the marketing render's
 * (`scripts/marketing-render.mjs`): the mean square of 50 ms blocks within
 * 30 dB of the loudest, in dB. -Infinity for silence.
 */
export function gatedRmsDb(channels, sampleRate) {
  const block = Math.max(1, Math.round(0.05 * sampleRate))
  const n = channels[0]?.length ?? 0
  const ms = []
  for (let s = 0; s + block <= n; s += block) {
    let sum = 0
    for (const c of channels) for (let i = s; i < s + block; i++) sum += c[i] * c[i]
    ms.push(sum / (block * channels.length))
  }
  if (!ms.length) return -Infinity
  let top = 0
  for (const v of ms) if (v > top) top = v
  let sum = 0, count = 0
  for (const v of ms) if (v > top * 1e-3) { sum += v; count++ }
  const mean = count ? sum / count : 0
  return mean > 0 ? 10 * Math.log10(mean) : -Infinity
}

/** The MP3 rate for a document's rate: MP3 has 32 / 44.1 / 48 kHz only. */
export function shareMp3Rate(docRate) {
  if (docRate === 44100 || docRate === 48000) return docRate
  return docRate % 11025 === 0 ? 44100 : 48000
}
