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
 * room tone do not pull the spectrum toward the noise floor. Both passes are
 * bounded: at most `maxRmsBlocks` evenly spread blocks are gated and at most
 * `maxBlocks` of those are transformed — the SHAPE of a voice does not need
 * every block of a chapter to measure. Channels are measured separately.
 *
 * Node-importable (no Vite specifiers), like analysisWindow.js.
 */

import { getSegmentDuration } from './operations.js'
import { ALIGN_GATE_RANGE_DB } from './dsp/inputAlign.js'
import { getFFT } from './dsp/fft.js'
import { magnitudeResponseDb } from './dsp/biquad.js'
import { layerBandSections, SAT_REF_CREST_DB, SAT_DEFAULT_REF_PEAK_DB } from './saturationBenchProcessor.js'

export const BAND_SPECTRUM_FFT = 2048

/**
 * The timeline's playing segments as a sorted, non-overlapping run, so a block
 * read can binary-search to its first segment instead of rescanning them all.
 */
function indexSegments(segments) {
  const idx = []
  for (const seg of segments) {
    if (seg.sourceBuffer === null) continue
    idx.push({ seg, start: seg.outputStart, end: seg.outputStart + getSegmentDuration(seg) })
  }
  idx.sort((a, b) => a.start - b.start)
  return idx
}

/** One channel of the timeline over [t0, t0 + n/sr), silence where nothing plays. */
function readChannel(index, ch, t0, n, sampleRate, out) {
  out.fill(0, 0, n)
  const t1 = t0 + n / sampleRate
  let lo = 0
  let hi = index.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index[mid].end <= t0) lo = mid + 1
    else hi = mid
  }
  for (let j = lo; j < index.length && index[j].start < t1; j++) {
    const { seg, start, end } = index[j]
    if (ch >= (seg.sourceBuffer.numberOfChannels ?? 1)) continue
    const overlapStart = Math.max(t0, start)
    const overlapEnd = Math.min(t1, end)
    const srcStart = Math.floor((seg.sourceStart + (overlapStart - start)) * sampleRate)
    const count = Math.floor((overlapEnd - overlapStart) * sampleRate)
    const outBase = Math.floor((overlapStart - t0) * sampleRate)
    const src = seg.sourceBuffer.getChannelData(ch)
    const m = Math.min(count, src.length - srcStart)
    for (let i = 0; i < m; i++) {
      const at = outBase + i
      if (at >= 0 && at < n) out[at] = src[srcStart + i]
    }
  }
}

/**
 * Gated long-term spectrum of [start, end).
 *
 * ⚠ CHANNELS ARE MEASURED APART, NEVER SUMMED. The shapers run per channel and
 * the voicing detector averages per-channel energy, so a (L + R) / n mono sum
 * would read a hard-panned file 6 dB low and let opposite-phase material cancel
 * to nothing. Block power is the MEAN of the channels' powers, and the spectrum
 * is their summed power.
 *
 * The gating pass reads at most `maxRmsBlocks` evenly spread blocks and the
 * transform at most `maxBlocks`, so the cost is bounded however long the file.
 *
 * @returns {{ gatedRmsDb: number, power: Float64Array, sampleRate: number, fftSize: number } | null}
 *   `power` is per rfft bin, normalised to sum 1; null for a silent region.
 */
export function measureBandSpectrum(
  segments, start, end, sampleRate, channels, { maxBlocks = 400, maxRmsBlocks = 4096 } = {},
) {
  const N = BAND_SPECTRUM_FFT
  const total = Math.floor((end - start) * sampleRate)
  const nBlocks = Math.floor(total / N)
  if (nBlocks < 1) return null
  const nCh = Math.max(1, channels)
  const index = indexSegments(segments)
  const buf = new Float64Array(N)

  const stride = Math.max(1, nBlocks / maxRmsBlocks)
  const sampled = []
  for (let p = 0; p < nBlocks; p += stride) sampled.push(Math.floor(p))
  const power = new Float64Array(sampled.length)
  for (let i = 0; i < sampled.length; i++) {
    let ms = 0
    for (let ch = 0; ch < nCh; ch++) {
      readChannel(index, ch, start + (sampled[i] * N) / sampleRate, N, sampleRate, buf)
      let s = 0
      for (let k = 0; k < N; k++) s += buf[k] * buf[k]
      ms += s / N
    }
    power[i] = ms / nCh
  }
  const sorted = Float64Array.from(power).sort()
  const ref = sorted[Math.min(sorted.length - 1, Math.round(0.95 * (sorted.length - 1)))]
  if (!(ref > 0)) return null
  // Power, so the gate's amplitude range is applied as 10^(-range/10).
  const gate = ref * Math.pow(10, -ALIGN_GATE_RANGE_DB / 10)
  const passing = []
  let sum = 0
  for (let i = 0; i < sampled.length; i++) {
    if (power[i] > gate) {
      passing.push(sampled[i])
      sum += power[i]
    }
  }
  if (passing.length === 0) return null
  const gatedRmsDb = 10 * Math.log10(sum / passing.length)

  const fft = getFFT(N)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const bins = N / 2 + 1
  const spec = new Float64Array(bins)
  const step = Math.max(1, passing.length / maxBlocks)
  for (let p = 0; p < passing.length; p += step) {
    const b = passing[Math.floor(p)]
    for (let ch = 0; ch < nCh; ch++) {
      readChannel(index, ch, start + (b * N) / sampleRate, N, sampleRate, buf)
      for (let i = 0; i < N; i++) {
        re[i] = buf[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
        im[i] = 0
      }
      fft.forward(re, im)
      for (let k = 0; k < bins; k++) spec[k] += re[k] * re[k] + im[k] * im[k]
    }
  }
  let tot = 0
  for (let k = 1; k < bins; k++) tot += spec[k]
  if (!(tot > 0)) return null
  spec[0] = 0
  for (let k = 1; k < bins; k++) spec[k] /= tot
  return { gatedRmsDb, power: spec, sampleRate, fftSize: N }
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
