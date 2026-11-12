/**
 * Sample-rate conversion for Save — Kaiser-windowed sinc, any ratio.
 *
 * Why not an OfflineAudioContext at the target rate: Chromium converts an
 * AudioBufferSourceNode's rate by LINEAR INTERPOLATION, which images and
 * aliases audibly on a 48 → 44.1 kHz conversion — and that is the most common
 * one here, since a document's buffers sit at the AudioContext's rate (the
 * device's, usually 48 kHz on Windows) whatever rate the file arrived at.
 *
 * The kernel is a band-limited sinc with its cutoff at 95 % of the LOWER of the
 * two Nyquists, 32 zero crossings either side, Kaiser β 9 (stopband ≈ −90 dB).
 * It is tabulated once per call at 512 points per zero crossing and linearly
 * interpolated, so any ratio works — 44100/47999 needs no rational reduction.
 * The passband reaches 95 % of the lower Nyquist (20.9 kHz going to 44.1 kHz).
 */

const ZERO_CROSSINGS = 32
const TABLE_OVERSAMPLE = 512
const KAISER_BETA = 9
const CUTOFF = 0.95

/** Zeroth-order modified Bessel function of the first kind (series). */
function besselI0(x) {
  let sum = 1, term = 1
  const q = (x * x) / 4
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k)
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

/**
 * Kernel table indexed by distance in units of the cutoff's zero crossings:
 * entry i is h(i / TABLE_OVERSAMPLE), h(u) = sinc(u) · kaiser(u / ZERO_CROSSINGS).
 * One extra entry past the end so interpolation at the edge never reads past it.
 */
function buildTable() {
  const n = ZERO_CROSSINGS * TABLE_OVERSAMPLE
  const table = new Float64Array(n + 2)
  const i0b = besselI0(KAISER_BETA)
  for (let i = 0; i <= n; i++) {
    const u = i / TABLE_OVERSAMPLE
    const r = u / ZERO_CROSSINGS
    const win = besselI0(KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u)
    table[i] = sinc * win
  }
  return table
}

let sharedTable = null

/** Output length for a conversion — exported so callers can size against it. */
export function resampledLength(inputLength, fromRate, toRate) {
  return Math.round(inputLength * toRate / fromRate)
}

/**
 * @param {Float32Array} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array} the input itself when the rates match
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error('sample rates must be positive')

  const table = sharedTable ?? (sharedTable = buildTable())
  const ratio = toRate / fromRate
  // Cutoff in cycles per INPUT sample, relative to the input's Nyquist.
  const fc = CUTOFF * Math.min(1, ratio)
  // Half-width of the kernel in input samples.
  const halfWidth = ZERO_CROSSINGS / fc
  // Table index per input sample of distance.
  const tableStep = fc * TABLE_OVERSAMPLE
  const tableMax = ZERO_CROSSINGS * TABLE_OVERSAMPLE

  const inLen = input.length
  const outLen = resampledLength(inLen, fromRate, toRate)
  const out = new Float32Array(outLen)

  for (let j = 0; j < outLen; j++) {
    const t = j / ratio
    const kStart = Math.max(0, Math.ceil(t - halfWidth))
    const kEnd = Math.min(inLen - 1, Math.floor(t + halfWidth))
    let acc = 0
    for (let k = kStart; k <= kEnd; k++) {
      const pos = Math.abs(k - t) * tableStep
      if (pos >= tableMax) continue
      const i = pos | 0
      const frac = pos - i
      acc += input[k] * (table[i] + (table[i + 1] - table[i]) * frac)
    }
    out[j] = acc * fc
  }
  return out
}
