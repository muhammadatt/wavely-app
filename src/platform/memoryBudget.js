/**
 * How much decoded audio the page can hold, and whether a file about to be
 * opened fits.
 *
 * Every open file lives in memory as 32-bit float PCM at the AudioContext's
 * rate: an hour of stereo at 48 kHz is 1.38 GB. Every apply adds a buffer the
 * size of its region, and undo keeps those alive. Desktop browsers usually
 * cope. iOS does not warn: past roughly 1–1.5 GB it kills the tab, and the user
 * loses every unsaved edit in every open file. So the pool's bytes are counted
 * (`bufferBytes`, kept by useEditorState) and a file is checked against a budget
 * BEFORE it is decoded (`checkImport`).
 *
 * Policy (all thresholds REASONED, not measured on devices):
 *   - Phones and tablets (`isMobileDevice`): REFUSE a file whose decode would
 *     take the pool past the budget — a refusal with a reason beats a crash
 *     that takes the other files with it — and WARN past 60 % of it.
 *   - Desktop: never refuse; WARN when the pool would pass the budget.
 * Decoding briefly holds about twice the decoded size (the browser's own
 * intermediate plus the result) on top of the compressed file's bytes, so a
 * refusal tests that peak; the warning tests what stays afterwards.
 *
 * The helpers take their globals as arguments so they can be tested without a
 * browser.
 */

const GiB = 1024 ** 3
const MiB = 1024 ** 2

/** Budget for phones and tablets whose memory the browser does not report. */
export const MOBILE_BUDGET_BYTES = 1 * GiB
/** Bounds for a phone that reports `navigator.deviceMemory` (Chrome on Android). */
export const MOBILE_BUDGET_MIN_BYTES = 512 * MiB
export const MOBILE_BUDGET_MAX_BYTES = 2 * GiB
/** Desktop budget when the browser does not report memory (Safari, Firefox). */
export const DESKTOP_BUDGET_BYTES = 4 * GiB
/** On a phone, warn once the pool would pass this share of the budget. */
export const MOBILE_WARN_SHARE = 0.6
/** Decoding briefly needs about this many times the decoded size. */
export const DECODE_PEAK_FACTOR = 2

/** Bytes an AudioBuffer (or anything shaped like one) holds: float32 per sample per channel. */
export function bufferBytes(buffer) {
  if (!buffer) return 0
  return (buffer.length || 0) * (buffer.numberOfChannels || 0) * 4
}

/**
 * Decoded size of a file: decodeAudioData resamples to the context's rate, so
 * the file's own rate does not matter, only its duration and channels.
 */
export function decodedBytes({ durationSec, channels, sampleRate }) {
  if (!(durationSec > 0) || !(channels > 0) || !(sampleRate > 0)) return null
  return Math.ceil(durationSec * sampleRate) * channels * 4
}

/**
 * Whether this is a phone or tablet, where the tab's memory limit is tight and
 * enforced by killing it. iPadOS reports itself as a Mac, so a "Mac" with
 * multi-touch is an iPad. This is the device, not the viewport: a narrow
 * desktop window has a desktop's memory.
 */
export function isMobileDevice(nav = globalThis.navigator) {
  const ua = nav?.userAgent ?? ''
  if (/iPhone|iPad|iPod|Android/i.test(ua)) return true
  return /Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1
}

/** The pool budget for this device, in bytes. */
export function memoryBudget(nav = globalThis.navigator) {
  const reportedGiB = Number(nav?.deviceMemory) || 0
  if (isMobileDevice(nav)) {
    if (!reportedGiB) return MOBILE_BUDGET_BYTES
    return clamp((reportedGiB * GiB) / 4, MOBILE_BUDGET_MIN_BYTES, MOBILE_BUDGET_MAX_BYTES)
  }
  // deviceMemory is capped at 8 by the spec, so this reads at most 4 GiB.
  if (!reportedGiB) return DESKTOP_BUDGET_BYTES
  return clamp((reportedGiB * GiB) / 2, 2 * GiB, DESKTOP_BUDGET_BYTES)
}

/**
 * Decide whether a file may be opened.
 *
 * @param {object} p
 * @param {number|null} p.newBytes   the file's decoded size (null = unknown: allowed)
 * @param {number} [p.fileBytes]     the compressed file's own size
 * @param {number} p.poolBytes       what is already in memory
 * @param {number} p.budgetBytes     from memoryBudget()
 * @param {boolean} p.mobile         from isMobileDevice()
 * @returns {{ action: 'ok' | 'warn' | 'refuse', afterBytes: number, peakBytes: number }}
 *   afterBytes: the pool once the file is open; peakBytes: the pool while it decodes
 */
export function checkImport({ newBytes, fileBytes = 0, poolBytes, budgetBytes, mobile }) {
  if (!(newBytes > 0)) return { action: 'ok', afterBytes: poolBytes, peakBytes: poolBytes }
  const afterBytes = poolBytes + newBytes
  const peakBytes = poolBytes + fileBytes + newBytes * DECODE_PEAK_FACTOR
  if (mobile) {
    if (peakBytes > budgetBytes) return { action: 'refuse', afterBytes, peakBytes }
    if (afterBytes > budgetBytes * MOBILE_WARN_SHARE) return { action: 'warn', afterBytes, peakBytes }
    return { action: 'ok', afterBytes, peakBytes }
  }
  return { action: afterBytes > budgetBytes ? 'warn' : 'ok', afterBytes, peakBytes }
}

/** "1.38 GB", "820 MB" — for messages. Decimal units, as file sizes are shown. */
export function formatBytes(bytes) {
  // Two decimals under 10 GB: a refusal sets what opening needs against what
  // is free, and at one decimal 1.076 and 1.074 GB both read "1.1 GB".
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes < 10e9 ? 2 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}

/**
 * The message for a refused or warned import, or null for 'ok'.
 * @param {'ok'|'warn'|'refuse'} action
 */
export function importMessage(action, { fileName, newBytes, peakBytes = newBytes, poolBytes = 0, budgetBytes, mobile }) {
  if (action === 'refuse') {
    // The figure is what OPENING needs (the decode peak), which is what did
    // not fit; quoting the decoded size alone read as "423 MB of 1.1 GB".
    const others = poolBytes >= 50e6 ? ' Closing other files frees memory.' : ''
    return `${fileName} is too long to open on this ${mobile ? 'phone or tablet' : 'device'}.`
      + ` Opening it takes about ${formatBytes(peakBytes - poolBytes)} of memory, and about`
      + ` ${formatBytes(Math.max(0, budgetBytes - poolBytes))} is free.${others}`
      + ' Try a shorter file, or open this one on a computer.'
  }
  if (action === 'warn') {
    return `${fileName} uses about ${formatBytes(newBytes)} of memory. With the files already open,`
      + ' this device may run out. Save your work and close files you are not using.'
  }
  return null
}

/**
 * A file's decoded size before decoding it: its duration from metadata, its
 * channels from the header (`readSourceFormat`; 2 when the header does not
 * say, as for M4A — an overestimate for mono), at the context's rate. Null
 * when the duration cannot be read, and the caller lets such a file through.
 */
export async function estimateDecodedBytes(file, { sourceFormat = null, sampleRate, probe = probeDuration } = {}) {
  const durationSec = await probe(file)
  return decodedBytes({ durationSec, channels: sourceFormat?.channels || 2, sampleRate })
}

/**
 * How long a file plays, from its metadata, without decoding it. Uses an audio
 * element (cheap: it reads only the header and index). Resolves null when the
 * browser cannot tell within `timeoutMs`.
 */
export function probeDuration(file, { doc = globalThis.document, url = globalThis.URL, timeoutMs = 2000 } = {}) {
  if (!file || !doc?.createElement || !url?.createObjectURL) return Promise.resolve(null)
  return new Promise((resolve) => {
    const audio = doc.createElement('audio')
    const src = url.createObjectURL(file)
    let timer = null
    const done = (value) => {
      clearTimeout(timer)
      audio.removeAttribute('src')
      audio.load?.()
      url.revokeObjectURL(src)
      resolve(Number.isFinite(value) && value > 0 ? value : null)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(audio.duration)
    audio.onerror = () => done(null)
    timer = setTimeout(() => done(null), timeoutMs)
    audio.src = src
  })
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}
