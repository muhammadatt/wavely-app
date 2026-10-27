/**
 * The Save dialog's rules: what it offers, what it defaults to, what it warns
 * about, and where a Save goes. All pure, so the parts users notice — whether
 * Save replaces the original, and whether the defaults can lose quality — are
 * testable without a browser.
 *
 * Deliberately light: the dialog imports this, so it must not reach the
 * encoders (the MP3 one loads WASM). Format constants live here and the
 * encoders import them.
 */
import { wavHeaderBytes } from './wavEncode.js'

/** Sample formats on offer. `id` is what the dialog binds and what is remembered. */
export const BIT_DEPTHS = [
  { id: '16', bits: 16, float: false, label: '16-bit PCM' },
  { id: '24', bits: 24, float: false, label: '24-bit PCM' },
  { id: '32f', bits: 32, float: true, label: '32-bit float' },
]

export const SAMPLE_RATES = [22050, 32000, 44100, 48000, 88200, 96000]

/** CBR bitrates offered for MP3, kbps. 192 is ACX's requirement. */
export const MP3_BITRATES = [128, 160, 192, 224, 256, 320]
/** MPEG-1 Layer III rates — the only ones the MP3 path writes (see mp3Encode.js). */
export const MP3_SAMPLE_RATES = [32000, 44100, 48000]
export const DEFAULT_MP3_BITRATE = 192

export const FORMATS = {
  wav: { id: 'wav', label: 'WAV', ext: '.wav', mime: 'audio/wav', lossy: false, depths: ['16', '24', '32f'] },
  flac: { id: 'flac', label: 'FLAC', ext: '.flac', mime: 'audio/flac', lossy: false, depths: ['16', '24'] },
  mp3: { id: 'mp3', label: 'MP3', ext: '.mp3', mime: 'audio/mpeg', lossy: true, depths: [] },
}
export const FORMAT_IDS = ['wav', 'flac', 'mp3']

const AUDIO_EXTENSIONS = /\.(wav|wave|flac|mp3|m4a|aac|ogg|oga|opus|aif|aiff|aifc|webm)$/i

export function bitDepthById(id) {
  return BIT_DEPTHS.find(d => d.id === id) ?? BIT_DEPTHS[0]
}

/** Whether a format can carry this many channels (MP3 stops at stereo). */
export function formatAvailable(format, channels) {
  return format !== 'mp3' || channels <= 2
}

/**
 * The sample rates to list for a format. WAV and FLAC: the standard set, plus
 * the source's and the document's own if either is something else (a
 * 47.952 kHz camera file should be savable at its own rate, not only converted
 * off it). MP3: its three rates, nothing else.
 */
export function sampleRateOptions(format, sourceFormat, docRate) {
  if (format === 'mp3') return [...MP3_SAMPLE_RATES]
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

/** The lowest offered bitrate at or above `kbps`, else the highest. */
function bitrateAtLeast(kbps) {
  return MP3_BITRATES.find(b => b >= kbps) ?? MP3_BITRATES[MP3_BITRATES.length - 1]
}

/**
 * Make a combination the chosen format can actually write: a depth FLAC does
 * not have becomes 24-bit, an MP3 rate snaps to the nearest MPEG-1 rate at or
 * above it, and MP3 on more than two channels falls back to WAV.
 *
 * @returns {{ format: string, bitDepth: string, sampleRate: number, bitrate: number }}
 */
export function normalizeSettings(settings, channels = 2) {
  let format = FORMATS[settings.format] ? settings.format : 'wav'
  if (!formatAvailable(format, channels)) format = 'wav'
  let { bitDepth = '16', sampleRate = 44100, bitrate = DEFAULT_MP3_BITRATE } = settings
  if (!MP3_BITRATES.includes(bitrate)) bitrate = bitrateAtLeast(bitrate)
  if (format === 'flac' && !FORMATS.flac.depths.includes(bitDepth)) bitDepth = '24'
  if (format === 'mp3' && !MP3_SAMPLE_RATES.includes(sampleRate)) {
    sampleRate = MP3_SAMPLE_RATES.find(r => r >= sampleRate) ?? MP3_SAMPLE_RATES[MP3_SAMPLE_RATES.length - 1]
  }
  return { format, bitDepth, sampleRate, bitrate }
}

/**
 * Defaults for a document never saved before: the source's own format, depth,
 * rate and (for an MP3) bitrate, so that accepting the dialog as it opens never
 * loses resolution. AIFF and lossy formats other than MP3 default to WAV.
 */
export function defaultSaveSettings(sourceFormat, docRate, channels = 2) {
  const container = sourceFormat?.container
  return normalizeSettings({
    format: FORMATS[container] ? container : 'wav',
    bitDepth: depthIdFor(sourceFormat),
    sampleRate: sourceFormat?.sampleRate || docRate,
    bitrate: sourceFormat?.bitrate ? bitrateAtLeast(sourceFormat.bitrate) : DEFAULT_MP3_BITRATE,
  }, channels)
}

/**
 * What the chosen settings throw away relative to the source, as a sentence,
 * or null when nothing is lost. A lossless file written from a lossy one is
 * never worse than its source, so only MP3 output can be lossy-on-lossy.
 */
export function qualityLossWarning(settings, sourceFormat) {
  const src = sourceFormat ?? null
  const parts = []
  if (src?.sampleRate && settings.sampleRate < src.sampleRate) {
    parts.push(`${formatRate(src.sampleRate)} → ${formatRate(settings.sampleRate)}`)
  }

  if (settings.format === 'mp3') {
    if (src?.container === 'mp3' && src.bitrate && settings.bitrate < src.bitrate) {
      parts.unshift(`${src.bitrate} → ${settings.bitrate} kbps`)
    }
    const detail = parts.length ? ` (${parts.join(', ')})` : ''
    if (!src) return parts.length ? `Lower than the original${detail}.` : null
    if (src.lossy) return `Re-encoding a lossy original loses a little more quality each time${detail}.`
    return `MP3 is lossy — keep a WAV or FLAC of the master${detail}.`
  }

  if (!src || src.lossy) return null
  const chosen = bitDepthById(settings.bitDepth)
  const srcBits = src.float ? 32 : src.bitDepth
  if (srcBits && (chosen.bits < srcBits || (src.float && !chosen.float))) {
    parts.unshift(`${src.float ? '32-bit float' : `${srcBits}-bit`} → ${chosen.label.replace(' PCM', '')}`)
  }
  if (parts.length === 0) return null
  return `Lower than the original (${parts.join(', ')}).`
}

export function formatRate(hz) {
  return `${Number((hz / 1000).toFixed(3))} kHz`
}

/**
 * The filename a Save writes: whatever was typed, with the format's extension.
 * An existing extension that already matches is kept as typed, so
 * "Chapter01.WAV" still names the file it came from; another audio extension
 * is swapped ("take.mp3" saved as FLAC is "take.flac"); anything else is kept
 * and the extension appended ("Chapter 1.2" → "Chapter 1.2.wav").
 */
export function toSaveFileName(fileName, format = 'wav') {
  const { ext } = FORMATS[format] ?? FORMATS.wav
  const trimmed = String(fileName ?? '').trim().replace(/[.\s]+$/, '')
  if (trimmed.toLowerCase().endsWith(ext) && /[^.\s]/.test(trimmed.slice(0, -ext.length))) return trimmed
  const base = trimmed.replace(AUDIO_EXTENSIONS, '')
  return (base || trimmed || 'untitled') + ext
}

/** WAV bytes for a timeline of `seconds` at these settings. */
export function wavBytesFor(seconds, channels, settings) {
  const depth = bitDepthById(settings.bitDepth)
  const frames = Math.round(seconds * settings.sampleRate)
  return frames * channels * (depth.bits / 8) + wavHeaderBytes({ float: depth.float })
}

/**
 * Expected file size. WAV is exact; MP3 is CBR, so within a frame; FLAC
 * depends on the material and is a rough guide (speech typically lands at
 * 50–65 % of PCM), shown with ≈.
 *
 * @returns {{ bytes: number, approx: boolean }}
 */
export function estimateSaveBytes(seconds, channels, settings) {
  if (settings.format === 'mp3') {
    return { bytes: Math.round(seconds * settings.bitrate * 125), approx: false }
  }
  const wav = wavBytesFor(seconds, channels, settings)
  if (settings.format === 'flac') return { bytes: Math.round(wav * 0.6), approx: true }
  return { bytes: wav, approx: false }
}

/**
 * Where a confirmed Save goes.
 *
 *   'download' — no write API in this browser; the bytes go to the downloads folder
 *   'chosen'   — the user already picked a destination with Change location…
 *   'replace'  — the name matches the file the anchor handle points at: write
 *                over it with no further dialog
 *   'pick'     — anything else: open the system save dialog in the anchor's
 *                folder with the name filled in, to confirm the location
 *
 * The anchor is the file last saved to, else the file the document was opened
 * from. ⚠ 'replace' NEEDS THE EXTENSION TO MATCH TOO, and gets it for free: the
 * name is compared after `toSaveFileName` gives it the chosen format's
 * extension, so FLAC bytes can never land in an .mp3 or a .wav — saving
 * take.mp3 as WAV names take.wav and goes to the system dialog.
 *
 * @param {{ supportsInPlace: boolean, chosenHandle?: object|null,
 *           anchorHandle?: object|null, fileName: string, format?: string }} p
 */
export function savePlan({ supportsInPlace, chosenHandle = null, anchorHandle = null, fileName, format = 'wav' }) {
  if (!supportsInPlace) return 'download'
  if (chosenHandle) return 'chosen'
  if (anchorHandle?.name && anchorHandle.name === toSaveFileName(fileName, format)) return 'replace'
  return 'pick'
}
