/**
 * Share links for saved chains and plugin presets: `<origin>/#share=<code>`.
 *
 * The settings travel IN THE LINK, so sharing needs no server, no account and
 * no storage, and a link keeps working for as long as the build can read it.
 * The fragment is never sent to a server (ours or a host's), so neither the
 * request log nor anyone's access log records what was shared.
 *
 * The code is the payload as JSON, deflate-compressed where the browser can
 * (CompressionStream), base64url-encoded, behind a one-letter format tag:
 *   z…  deflate-raw
 *   j…  plain JSON (no CompressionStream)
 * A five-slot chain is ~1 kB compressed.
 *
 * Payloads:
 *   { v: 1, kind: 'chain',  name, params: { slots } }          a saved chain
 *   { v: 1, kind: 'preset', name, preset, params }             one plugin's preset
 * where `preset` is the plugin's PRESET COLLECTION id (`opto-smooth`,
 * `hf-softener`, …), not its registry id — the receiver maps it back.
 *
 * ⚠ A LINK IS UNTRUSTED INPUT. `decodeShare` checks only the shape and the
 * size; what each plugin will accept is checked where every saved preset is,
 * by the plugin's own whitelist and `normalize` (writePluginSettings) when the
 * link is loaded. Nothing here reaches a kernel.
 */

export const SHARE_PARAM = 'share'
export const SHARE_VERSION = 1

/** Decoded JSON larger than this is refused (a real chain is a few kB). */
export const SHARE_MAX_JSON_BYTES = 64 * 1024
/** A link's code longer than this is refused before it is decoded. */
export const SHARE_MAX_CODE_LENGTH = 48 * 1024
/** Names are display text only, and kept short. */
export const SHARE_MAX_NAME = 48

const KINDS = new Set(['chain', 'preset'])

function toBase64Url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const canCompress = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function'

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream))
  return new Uint8Array(await res.arrayBuffer())
}

/** Inflate, giving up past `limit` bytes rather than inflating a bomb whole. */
async function inflate(bytes, limit) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader()
  const parts = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      reader.cancel().catch(() => {})
      throw new Error('too large')
    }
    parts.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

function cleanName(name, fallback) {
  const s = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, SHARE_MAX_NAME) : ''
  return s || fallback
}

/** The payload's shape, or null. Does not judge the settings themselves. */
export function normalizeShare(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.v !== SHARE_VERSION || !KINDS.has(raw.kind)) return null
  const params = raw.params
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  if (raw.kind === 'chain') {
    if (!Array.isArray(params.slots) || !params.slots.length) return null
    return { v: SHARE_VERSION, kind: 'chain', name: cleanName(raw.name, 'Shared chain'), params: { slots: params.slots } }
  }
  const preset = typeof raw.preset === 'string' ? raw.preset.trim() : ''
  if (!preset || preset.length > 64) return null
  return { v: SHARE_VERSION, kind: 'preset', preset, name: cleanName(raw.name, 'Shared preset'), params }
}

/** The link code for a payload. */
export async function encodeShare(payload) {
  const clean = normalizeShare(payload)
  if (!clean) throw new Error('encodeShare: not a shareable payload')
  const json = new TextEncoder().encode(JSON.stringify(clean))
  if (json.length > SHARE_MAX_JSON_BYTES) throw new Error('These settings are too large to share as a link.')
  if (canCompress()) return 'z' + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')))
  return 'j' + toBase64Url(json)
}

/** The payload a link code carries, or null for anything unreadable. Never throws. */
export async function decodeShare(code) {
  try {
    if (typeof code !== 'string' || code.length < 2 || code.length > SHARE_MAX_CODE_LENGTH) return null
    const tag = code[0]
    const bytes = fromBase64Url(code.slice(1))
    let json
    if (tag === 'z') {
      if (!canCompress()) return null
      json = await inflate(bytes, SHARE_MAX_JSON_BYTES)
    } else if (tag === 'j') {
      if (bytes.length > SHARE_MAX_JSON_BYTES) return null
      json = bytes
    } else {
      return null
    }
    return normalizeShare(JSON.parse(new TextDecoder().decode(json)))
  } catch {
    return null
  }
}

/** The full link for a code, on `origin` (the editor lives at `/`). */
export function shareUrl(code, origin) {
  return `${origin.replace(/\/+$/, '')}/#${SHARE_PARAM}=${code}`
}

/** The code in a location hash (`#share=…`), or null. */
export function shareCodeFromHash(hash) {
  if (typeof hash !== 'string') return null
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const code = params.get(SHARE_PARAM)
  return code || null
}

/** The hash with the share code taken out ('' when nothing else was in it). */
export function hashWithoutShare(hash) {
  if (typeof hash !== 'string' || !hash) return ''
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  if (!params.has(SHARE_PARAM)) return hash
  params.delete(SHARE_PARAM)
  const rest = params.toString()
  return rest ? `#${rest}` : ''
}
