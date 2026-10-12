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
 * ⚠ IT FEEDS WARMTH THE SOURCE, NOT TAPE'S OUTPUT. TAPE now runs first, so in
 * the plugin Warmth sees the source soft-clipped and lifted by TAPE's makeup
 * (+1.2 to +1.7 dB of body at TAPE 2). With TAPE on, the bands are what Warmth
 * does to the source — close, not exact — and the peak stays an upper bound,
 * since the makeup puts TAPE's peak back on the source's and the guard holds
 * Warmth there either way. Rendering TAPE first would add ~6 s per 10 min to
 * the whole-region peak pass.
 *
 * ⚠ THE BANDS ARE SAMPLED ACROSS THE WHOLE SELECTION, NOT A CAPPED WINDOW
 * (October 2026). They were the first 30 s, which describes the opening, not
 * the take: on a 175 s file mixing narration and drums the first 30 s read up
 * to 7.7 dB off the whole render (+10.3 at 60–120 Hz where the whole read
 * +2.4). Selections up to READOUT_WHOLE_MAX_S are rendered whole; longer ones
 * render READOUT_BLOCKS blocks of READOUT_BLOCK_S, one per equal stratum at a
 * golden-ratio offset (evenly spaced blocks alias against loops), each with
 * READOUT_PREROLL_S of run-in, energies pooled — 0.41 / 0.58 dB worst on that
 * file at Warmth 5 / 10, in about half the old window's render time. More or
 * longer blocks barely helped (0.28–0.57 at 16–30 blocks); the run-in read the
 * same at 0.25 and 0.5 s, and fading it in from silence changed nothing.
 * ⚠ THE PEAK IS NOT RENDERED ON A LONG SELECTION — IT IS KNOWN. With Warmth up
 * the peak guard is pinned on with the selection's own peak as its ceiling, and
 * its no-overshoot proof holds |out| ≤ max(ceiling, |x|) = that peak: the
 * stage cannot raise it (measured: 0.000 dB change at Warmth 5 and 10 on the
 * whole file above). So the caller reports the selection's peak as the bound
 * and skips the whole-region pass that used to run on its own worker (~8 s of
 * CPU for 3 min of mono, per knob turn). A short selection still measures it.
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
 * Render `channelData` through the warmth layers — and the peak guard,
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

/** Selections up to this long are rendered whole for the bands, seconds. */
export const READOUT_WHOLE_MAX_S = 15
/** Blocks rendered for a longer selection, and each block's length and run-in, seconds. */
export const READOUT_BLOCKS = 12
export const READOUT_BLOCK_S = 1
export const READOUT_PREROLL_S = 0.25

/**
 * The sampled blocks for a selection of `n` samples: `[from, to, skip]` each,
 * `from` including the run-in and `skip` its length. One block per equal
 * stratum, at a golden-ratio offset inside it.
 */
export function readoutBlocks(n, sampleRate) {
  const blk = Math.round(READOUT_BLOCK_S * sampleRate)
  const pre = Math.round(READOUT_PREROLL_S * sampleRate)
  const stratum = n / READOUT_BLOCKS
  const out = []
  for (let k = 0; k < READOUT_BLOCKS; k++) {
    const jitter = ((k + 1) * 0.6180339887498949) % 1
    const s = Math.min(n - blk, Math.floor(k * stratum + jitter * Math.max(0, stratum - blk)))
    const a = Math.max(0, s - pre)
    out.push([a, s + blk, s - a])
  }
  return out
}

/**
 * The bands from sampled blocks: each `{ channelData, skip }` rendered with
 * its run-in, the band energies pooled over every block.
 * @returns {(number|null)[] | null} output minus input per WARMTH_READOUT_BANDS
 */
export function measureWarmthBandsSampled(blocks, sampleRate, layers, guard = null) {
  const ein = WARMTH_READOUT_BANDS.map(() => 0)
  const eout = WARMTH_READOUT_BANDS.map(() => 0)
  let any = false
  for (const b of blocks) {
    const r = measureWarmthReadout(b.channelData, sampleRate, layers, { guard, skip: b.skip, energies: true })
    if (!r.ein || !r.eout) continue
    any = true
    for (let i = 0; i < ein.length; i++) {
      ein[i] += r.ein[i]
      eout[i] += r.eout[i]
    }
  }
  if (!any) return null
  return ein.map((e, i) => (e > 1e-20 ? 10 * Math.log10(eout[i] / e) : null))
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
export function measureWarmthReadout(channelData, sampleRate, layers, { bands = true, peak = true, guard = null, skip = 0, energies = false } = {}) {
  const rendered = renderWarmthAligned(channelData, sampleRate, layers, guard)
  // `skip`: a run-in rendered for the layers' and guard's state, then dropped.
  const out = skip > 0 ? rendered.map(c => c.subarray(skip)) : rendered
  if (skip > 0) channelData = channelData.map(c => c.subarray(skip))
  // `energies`: the raw band energies, for a caller pooling several blocks.
  if (energies) return { ein: bandEnergies(channelData, sampleRate), eout: bandEnergies(out, sampleRate) }
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
