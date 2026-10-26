/**
 * The Save dialog's rules: what it offers, what it defaults to, what it warns
 * about, and where a Save goes. All pure, so the parts users notice — whether
 * Save replaces the original, and whether the defaults can lose quality — are
 * testable without a browser.
 */
import { toWavFileName } from './download.js'
import { wavHeaderBytes } from './wavEncode.js'

/** Sample formats on offer. `id` is what the dialog binds and what is remembered. */
export const BIT_DEPTHS = [
  { id: '16', bits: 16, float: false, label: '16-bit PCM' },
  { id: '24', bits: 24, float: false, label: '24-bit PCM' },
  { id: '32f', bits: 32, float: true, label: '32-bit float' },
]

export const SAMPLE_RATES = [22050, 32000, 44100, 48000, 88200, 96000]

export function bitDepthById(id) {
  return BIT_DEPTHS.find(d => d.id === id) ?? BIT_DEPTHS[0]
}

/**
 * The sample rates to list: the standard set, plus the source's and the
 * document's own if either is something else (a 47.952 kHz camera file should
 * be savable at its own rate, not only converted off it).
 */
export function sampleRateOptions(sourceFormat, docRate) {
  const set = new Set(SAMPLE_RATES)
  if (sourceFormat?.sampleRate) set.add(sourceFormat.sampleRate)
  if (docRate) set.add(docRate)
  return [...set].sort((a, b) => a - b)
}

/** The depth id that keeps a source's resolution. */
function depthIdFor(sourceFormat) {
  if (!sourceFormat || sourceFormat.lossy || !sourceFormat.bitDepth) return '16'
  if (sourceFormat.float || sourceFormat.bitDepth > 24) return '32f'
  if (sourceFormat.bitDepth > 16) return '24'
  return '16'
}

/**
 * Defaults for a document never saved before: the source's own depth and rate,
 * so that accepting the dialog as it opens never loses resolution. A lossy or
 * unreadable source has no depth to keep and gets 16-bit at the document's rate.
 *
 * @returns {{ bitDepth: string, sampleRate: number }}
 */
export function defaultSaveSettings(sourceFormat, docRate) {
  return {
    bitDepth: depthIdFor(sourceFormat),
    sampleRate: sourceFormat?.sampleRate || docRate,
  }
}

/**
 * What the chosen settings throw away relative to the source, as a sentence,
 * or null when nothing is lost. Only lossless sources can be degraded: a WAV
 * written from an MP3 is never worse than the MP3.
 */
export function qualityLossWarning(settings, sourceFormat) {
  if (!sourceFormat || sourceFormat.lossy) return null
  const parts = []
  const chosen = bitDepthById(settings.bitDepth)
  const srcBits = sourceFormat.float ? 32 : sourceFormat.bitDepth
  if (srcBits && (chosen.bits < srcBits || (sourceFormat.float && !chosen.float))) {
    parts.push(`${sourceFormat.float ? '32-bit float' : `${srcBits}-bit`} → ${chosen.label.replace(' PCM', '')}`)
  }
  if (sourceFormat.sampleRate && settings.sampleRate < sourceFormat.sampleRate) {
    parts.push(`${formatRate(sourceFormat.sampleRate)} → ${formatRate(settings.sampleRate)}`)
  }
  if (parts.length === 0) return null
  return `Lower than the original (${parts.join(', ')}).`
}

export function formatRate(hz) {
  return `${Number((hz / 1000).toFixed(3))} kHz`
}

/**
 * The filename a Save writes: whatever was typed, with a .wav extension. An
 * existing .wav / .WAV is kept as typed, so "Chapter01.WAV" still names the
 * file it came from; anything else has its extension swapped (toWavFileName).
 */
export function toSaveFileName(fileName) {
  const trimmed = String(fileName ?? '').trim()
  return /[^.\s]\.wav$/i.test(trimmed) ? trimmed : toWavFileName(trimmed)
}

/** WAV bytes for a timeline of `seconds` at these settings. */
export function wavBytesFor(seconds, channels, settings) {
  const depth = bitDepthById(settings.bitDepth)
  const frames = Math.round(seconds * settings.sampleRate)
  return frames * channels * (depth.bits / 8) + wavHeaderBytes({ float: depth.float })
}

/**
 * Where a confirmed Save goes.
 *
 *   'download' — no write API in this browser; the bytes go to the downloads folder
 *   'chosen'   — the user already picked a destination with Change location…
 *   'replace'  — the name matches the file the anchor handle points at, and that
 *                file is a WAV: write over it with no further dialog
 *   'pick'     — anything else: open the system save dialog in the anchor's
 *                folder with the name filled in, to confirm the location
 *
 * The anchor is the file last saved to, else the file the document was opened
 * from. ⚠ 'replace' NEVER APPLIES TO A NON-WAV ANCHOR: the output is always a
 * WAV, and WAV bytes under an .mp3 name is a file nothing will open. The name
 * test already guarantees it (the dialog's name always ends in .wav), and the
 * extension check says so out loud rather than relying on that.
 *
 * @param {{ supportsInPlace: boolean, chosenHandle?: object|null,
 *           anchorHandle?: object|null, fileName: string }} p
 */
export function savePlan({ supportsInPlace, chosenHandle = null, anchorHandle = null, fileName }) {
  if (!supportsInPlace) return 'download'
  if (chosenHandle) return 'chosen'
  const name = toSaveFileName(fileName)
  if (anchorHandle?.name && /\.wav$/i.test(anchorHandle.name) && anchorHandle.name === name) {
    return 'replace'
  }
  return 'pick'
}
