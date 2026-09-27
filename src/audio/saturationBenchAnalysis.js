/**
 * Saturation Bench's drive calibration: the level each layer's BAND reaches on
 * this recording.
 *
 * A layer's 0 dB drive puts its curve at 1 % THD on a sine peaking at the
 * band's reference peak, so the plugin needs that peak for any band the user
 * dials. Measuring it per band by filtering the file would cost a full pass per
 * knob move; instead this takes ONE gated long-term average spectrum of the
 * file and integrates it under the band's own filter response, which is cheap
 * enough to run on every change.
 *
 *   refPeakDb = gated RMS of the file
 *             + 10·log10( Σ P(f)·|H_band(f)|² / Σ P(f) )
 *             + SAT_REF_CREST_DB
 *
 * With the band open this is the gated RMS + 12 dB, which on a file at the
 * nominal −20 dBFS is −8 dBFS: the HF Softener shaper's full-band calibration
 * point exactly.
 *
 * GATING: 2048-sample blocks, the same rule as the compressors' level
 * alignment (blocks within 30 dB of the 95th-percentile block), so pauses and
 * room tone do not pull the spectrum toward the noise floor. At most
 * `maxBlocks` gated blocks, evenly spread, are transformed — the SHAPE of a
 * voice does not need every block of a chapter to measure.
 *
 * Node-importable (no Vite specifiers), like analysisWindow.js.
 */

import { getSegmentDuration } from './operations.js'
import { ALIGN_GATE_RANGE_DB } from './dsp/inputAlign.js'
import { getFFT } from './dsp/fft.js'
import { magnitudeResponseDb } from './dsp/biquad.js'
import { layerBandSections, SAT_REF_CREST_DB, SAT_DEFAULT_REF_PEAK_DB } from './saturationBenchProcessor.js'

export const BAND_SPECTRUM_FFT = 2048

/** Mono sum of the timeline over [t0, t0 + n/sr), silence where nothing plays. */
function readMono(segments, t0, n, sampleRate, channels, out) {
  out.fill(0, 0, n)
  const t1 = t0 + n / sampleRate
  for (const seg of segments) {
    const dur = getSegmentDuration(seg)
    const segEnd = seg.outputStart + dur
    if (segEnd <= t0 || seg.outputStart >= t1) continue
    if (seg.sourceBuffer === null) continue
    const overlapStart = Math.max(t0, seg.outputStart)
    const overlapEnd = Math.min(t1, segEnd)
    const srcStart = Math.floor((seg.sourceStart + (overlapStart - seg.outputStart)) * sampleRate)
    const count = Math.floor((overlapEnd - overlapStart) * sampleRate)
    const outBase = Math.floor((overlapStart - t0) * sampleRate)
    const nCh = Math.min(channels, seg.sourceBuffer.numberOfChannels ?? channels)
    for (let ch = 0; ch < nCh; ch++) {
      const src = seg.sourceBuffer.getChannelData(ch)
      const m = Math.min(count, src.length - srcStart)
      for (let i = 0; i < m; i++) {
        const at = outBase + i
        if (at >= 0 && at < n) out[at] += src[srcStart + i] / channels
      }
    }
  }
}

/**
 * Gated long-term spectrum of [start, end).
 *
 * @returns {{ gatedRmsDb: number, power: Float64Array, sampleRate: number, fftSize: number } | null}
 *   `power` is per rfft bin, normalised to sum 1; null for a silent region.
 */
export function measureBandSpectrum(segments, start, end, sampleRate, channels, { maxBlocks = 400 } = {}) {
  const N = BAND_SPECTRUM_FFT
  const total = Math.floor((end - start) * sampleRate)
  const nBlocks = Math.floor(total / N)
  if (nBlocks < 1) return null
  const buf = new Float64Array(N)

  const rms = new Float64Array(nBlocks)
  for (let b = 0; b < nBlocks; b++) {
    readMono(segments, start + (b * N) / sampleRate, N, sampleRate, channels, buf)
    let s = 0
    for (let i = 0; i < N; i++) s += buf[i] * buf[i]
    rms[b] = Math.sqrt(s / N)
  }
  const sorted = Float64Array.from(rms).sort()
  const ref = sorted[Math.min(nBlocks - 1, Math.round(0.95 * (nBlocks - 1)))]
  if (!(ref > 0)) return null
  const gate = ref * Math.pow(10, -ALIGN_GATE_RANGE_DB / 20)
  const passing = []
  let sum = 0
  for (let b = 0; b < nBlocks; b++) {
    if (rms[b] > gate) {
      passing.push(b)
      sum += rms[b] * rms[b]
    }
  }
  if (passing.length === 0) return null
  const gatedRmsDb = 10 * Math.log10(sum / passing.length)

  const fft = getFFT(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const bins = N / 2 + 1
  const power = new Float64Array(bins)
  const step = Math.max(1, passing.length / maxBlocks)
  for (let p = 0; p < passing.length; p += step) {
    const b = passing[Math.floor(p)]
    readMono(segments, start + (b * N) / sampleRate, N, sampleRate, channels, buf)
    for (let i = 0; i < N; i++) {
      re[i] = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
      im[i] = 0
    }
    fft.forward(re, im)
    for (let k = 0; k < bins; k++) power[k] += re[k] * re[k] + im[k] * im[k]
  }
  let tot = 0
  for (let k = 1; k < bins; k++) tot += power[k]
  if (!(tot > 0)) return null
  power[0] = 0
  for (let k = 1; k < bins; k++) power[k] /= tot
  return { gatedRmsDb, power, sampleRate, fftSize: N }
}

/** The reference peak, dBFS, for a band — see the module comment. */
export function bandRefPeakDb(spectrum, loHz, hiHz) {
  if (!spectrum) return SAT_DEFAULT_REF_PEAK_DB
  const { power, sampleRate, fftSize } = spectrum
  const freqs = []
  for (let k = 1; k < power.length; k++) freqs.push((k * sampleRate) / fftSize)
  const resp = magnitudeResponseDb(layerBandSections(loHz, hiHz, sampleRate), freqs, sampleRate)
  let s = 0
  for (let k = 1; k < power.length; k++) s += power[k] * Math.pow(10, resp[k - 1] / 10)
  const frac = s > 1e-12 ? s : 1e-12
  return spectrum.gatedRmsDb + 10 * Math.log10(frac) + SAT_REF_CREST_DB
}

/** The voicing detector's level offset: gated RMS against nominal −20 dBFS. */
export function voicingOffsetDb(spectrum) {
  if (!spectrum) return 0
  const v = spectrum.gatedRmsDb + 20
  return v > 24 ? 24 : v < -24 ? -24 : v
}
