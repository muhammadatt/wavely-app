/**
 * PHAT*SS — the Warmth readout: what the Warmth stage does to a region's
 * low end, per band, and the peak it leaves. The panel prints these so a
 * setting can be judged by the numbers, not only by ear.
 *
 * ⚠ IT RENDERS THE WARMTH STAGE ALONE, NOT THE WHOLE PLUGIN. The shelf only
 * ever takes the top end down (`the limiter never adds energy or raises the
 * peak` pins it), so the bands below 400 Hz are the stage's, and the stage's
 * peak — plus the Output trim, added by the panel — is an upper bound on what
 * the plugin delivers. Rendering the shelf too would cost ~40 % more for no
 * band it can move.
 *
 * ⚠ THE BANDS AND THE PEAK ARE MEASURED OVER DIFFERENT SPANS, ON PURPOSE. The
 * bands are a property of the setting and are answered by the usual capped
 * window; the peak is a property of the WHOLE region — a capped window can
 * only read it low, and a late loud passage is exactly where a low-end boost
 * clips. So the caller asks for the peak over the whole region separately
 * (see `measurePhatassWarmthPeak`).
 *
 * Node-importable: no worklet registration, no Vite specifiers.
 */

import { processSaturationBenchBuffer } from './dsp/saturationLayers.js'
import { WarmthPeakGuard } from './dsp/warmthGuard.js'
import { getFFT } from './dsp/fft.js'

/** The bands the readout reports, Hz: sub, low, body, low-mid. */
export const WARMTH_READOUT_BANDS = [[20, 60], [60, 120], [120, 250], [250, 400]]

/** Welch frame for the band energies: 8192 gives ~5–11 Hz bins at 44.1–96 kHz. */
const FRAME = 8192
/** Below this many samples the low bands are not resolvable; report none. */
const MIN_SAMPLES = 4096

/**
 * Render `channelData` through the two warmth layers — and the peak guard,
 * when `guard` (`{ on, ceilingDb }`, the kernel's `warmthGuard`) is on — and
 * return the output aligned to the input, sample for sample (latency removed,
 * tail flushed). The guard runs on the aligned pair, so it sees exactly the
 * input and added signal the plugin's guard does.
 */
export function renderWarmthAligned(channelData, sampleRate, layers, guard = null) {
  const n = channelData[0].length
  const pad = 2048
  const padded = channelData.map((c) => {
    const p = new Float32Array(n + pad)
    p.set(c)
    return p
  })
  const { channelData: out, latencySamples } = processSaturationBenchBuffer(
    padded, sampleRate, { layers }, { slots: layers.length, oversample: layers.map(l => l.oversample !== false) },
  )
  const aligned = out.map(c => c.subarray(latencySamples, latencySamples + n))
  if (!guard?.on) return aligned
  const g = new WarmthPeakGuard(sampleRate, 0)
  g.setParams(guard)
  const L = g.latencySamples
  const x = channelData.map((c) => {
    const p = new Float32Array(n + L)
    p.set(c)
    return p
  })
  const y = aligned.map((c) => {
    const p = new Float32Array(n + L)
    p.set(c)
    return p
  })
  for (let off = 0; off < n + L; off += 128) {
    const len = Math.min(128, n + L - off)
    g.process(x.map(c => c.subarray(off, off + len)), y.map(c => c.subarray(off, off + len)), len)
  }
  return y.map(c => c.subarray(L, L + n))
}

/** Per-band energy of `chs` (summed over channels), Welch-averaged. */
function bandEnergies(chs, sampleRate) {
  const n = chs[0].length
  let N = FRAME
  while (N > n && N > MIN_SAMPLES) N >>= 1
  if (n < N) return null
  const fft = getFFT(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const P = new Float64Array(N / 2)
  const hop = N / 2
  for (const y of chs) {
    for (let o = 0; o + N <= n; o += hop) {
      for (let i = 0; i < N; i++) {
        re[i] = y[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
        im[i] = 0
      }
      fft.forward(re, im)
      for (let k = 0; k < N / 2; k++) P[k] += re[k] * re[k] + im[k] * im[k]
    }
  }
  return WARMTH_READOUT_BANDS.map(([lo, hi]) => {
    let e = 0
    const k0 = Math.max(1, Math.round((lo * N) / sampleRate))
    const k1 = Math.min(N / 2, Math.round((hi * N) / sampleRate))
    for (let k = k0; k < k1; k++) e += P[k]
    return e
  })
}

function peakDbOf(chs) {
  let m = 0
  for (const c of chs) for (let i = 0; i < c.length; i++) {
    const a = Math.abs(c[i])
    if (a > m) m = a
  }
  return m > 0 ? 20 * Math.log10(m) : -Infinity
}

/**
 * The readout for one region.
 *
 * @param {Float32Array[]} channelData the region, as `renderRegionToBuffer` gives it
 * @param {object[]} layers the warmth layers' kernel params (`warmthLayers`, 1–4 of them)
 * @param {{ bands?: boolean, peak?: boolean, guard?: object }} what — `guard` is the kernel's `warmthGuard`
 * @returns {{ bandsDb: (number|null)[] | null, peakDb: number | null, inputPeakDb: number | null }}
 *   `bandsDb[i]` is output minus input in WARMTH_READOUT_BANDS[i], null where
 *   the input has nothing there; `peakDb` is the stage's output peak and
 *   `inputPeakDb` the region's own, both dBFS over the same span, so the panel
 *   can print the CHANGE.
 */
export function measureWarmthReadout(channelData, sampleRate, layers, { bands = true, peak = true, guard = null } = {}) {
  const out = renderWarmthAligned(channelData, sampleRate, layers, guard)
  let bandsDb = null
  if (bands) {
    const ein = bandEnergies(channelData, sampleRate)
    const eout = bandEnergies(out, sampleRate)
    if (ein && eout) {
      bandsDb = ein.map((e, i) => (e > 1e-20 ? 10 * Math.log10(eout[i] / e) : null))
    }
  }
  return { bandsDb, peakDb: peak ? peakDbOf(out) : null, inputPeakDb: peak ? peakDbOf(channelData) : null }
}
