/**
 * TAPE COMPRESSION — a fast, low-weighted, feed-forward gain stage ahead of
 * PHAT*SS's TAPE curve (bench prototype).
 *
 * WHY: measured against two Studer A800 dry/wet drum pairs, the Studer lowers a
 * loud kick's WHOLE first cycles smoothly — a sample at 20–40 % of the cycle's
 * peak is already 3–7 dB down while quiet material between hits passes at full
 * level, and the cycle comes out shrunken but still pointed — and lets go over
 * ~30–100 ms. A memoryless curve (or hysteresis, whose memory is within a
 * cycle) can only flatten the crest. This is the envelope-timescale part; TAPE
 * after it adds the crest rounding and the harmonics.
 *
 * DETECTOR: the input through a high shelf CUT (`tiltDb` at `tiltHz`), so the
 * lows drive it harder than the top — the Studer squashed kick-led hits more
 * than snare-led ones. Linked across channels (max). PEAK mode follows |sc|
 * with one-pole attack/release; RMS follows sc² the same way and reads
 * sqrt(2·ms), so a steady sine reads its peak in both modes and the threshold
 * calibration does not move with the mode.
 *
 * GAIN: soft-knee (quadratic) downward compression, `ratio`, in dB, applied as
 * one full-band gain — the waveform's shape survives, which is the point.
 * Zero latency, no lookahead: a bit-exact pass-through when off.
 *
 * Pure: no worklet, no DOM.
 */

import { BiquadCascade, highShelf } from './biquad.js'

const LN10_OVER_20 = Math.LN10 / 20
const coeff = (ms, sr) => (ms > 0 ? 1 - Math.exp(-1 / (ms * 1e-3 * sr)) : 1)

export const TAPE_COMP_OFF = Object.freeze({
  on: false,
  thresholdDb: 0,
  ratio: 4,
  kneeDb: 6,
  attackMs: 1,
  releaseMs: 60,
  detector: 'rms',
  tiltDb: 0,
  tiltHz: 300,
})

export class TapeCompressor {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.sc = new BiquadCascade(1, 2)
    this.scBuf = []
    this.env = 0
    this.p = { ...TAPE_COMP_OFF }
    this.tiltKey = ''
    /** Smallest gain applied since the last `takeMinGain()` (metering, tests). */
    this.minGain = 1
    /** The last block's per-sample gains (valid while on), for the saturation meter. */
    this.gains = new Float32Array(128)
  }

  setParams(partial) {
    const p = { ...this.p, ...partial }
    const wasOn = this.p.on
    this.p = p
    this.aAtt = coeff(p.attackMs, this.sampleRate)
    this.aRel = coeff(p.releaseMs, this.sampleRate)
    this.slope = 1 - 1 / Math.max(1, p.ratio)
    const key = `${p.tiltDb}@${p.tiltHz}`
    if (key !== this.tiltKey) {
      this.tiltKey = key
      this.sc.setSection(0, highShelf(this.sampleRate, p.tiltHz, Math.SQRT1_2, -Math.max(0, p.tiltDb)))
    }
    if (p.on && !wasOn) this.reset()
  }

  reset() {
    this.env = 0
    this.sc.reset()
  }

  takeMinGain() {
    const g = this.minGain
    this.minGain = 1
    return g
  }

  /** In place over `chs` (n samples each). */
  process(chs, n) {
    const p = this.p
    if (!p.on) return
    const nCh = chs.length
    this.sc.ensureChannels(nCh)
    let src = chs
    if (p.tiltDb > 0) {
      while (this.scBuf.length < nCh) this.scBuf.push(new Float32Array(n))
      for (let ch = 0; ch < nCh; ch++) {
        if (this.scBuf[ch].length < n) this.scBuf[ch] = new Float32Array(n)
        this.sc.process(chs[ch], this.scBuf[ch], n, ch)
      }
      src = this.scBuf
    }
    const rms = p.detector === 'rms'
    const aA = this.aAtt
    const aR = this.aRel
    const T = p.thresholdDb
    const K = Math.max(0, p.kneeDb)
    const S = this.slope
    let env = this.env
    let minG = this.minGain
    if (this.gains.length < n) this.gains = new Float32Array(n)
    const gains = this.gains
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let ch = 0; ch < nCh; ch++) {
        const v = src[ch][i]
        const a = rms ? v * v : Math.abs(v)
        if (a > r) r = a
      }
      env += (r > env ? aA : aR) * (r - env)
      const lev = rms ? Math.sqrt(2 * env) : env
      let g = 1
      if (lev > 1e-9) {
        const over = 20 * Math.log10(lev) - T
        let gr = 0
        if (over >= K / 2) gr = S * over
        else if (K > 0 && over > -K / 2) gr = S * (over + K / 2) ** 2 / (2 * K)
        if (gr > 0) g = Math.exp(-gr * LN10_OVER_20)
      }
      if (g < minG) minG = g
      gains[i] = g
      if (g !== 1) for (let ch = 0; ch < nCh; ch++) chs[ch][i] *= g
    }
    // Denormal guard on a decaying envelope.
    this.env = env < 1e-30 ? 0 : env
    this.minGain = minG
  }
}

/** The calibration tone: a kick's fundamental, under any sensible tilt corner. */
export const TAPE_COMP_CAL_HZ = 55
const CAL_SR = 48000
const calCache = new Map()

/** Fundamental loss (dB, ≤ 0) of a steady unit CAL tone through the compressor at threshold `thrDb`. */
function toneLossDb(voicing, thrDb) {
  const tc = new TapeCompressor(CAL_SR)
  tc.setParams({ ...voicing, on: true, thresholdDb: thrDb })
  const n = Math.round(0.3 * CAL_SR)
  const w = (2 * Math.PI * TAPE_COMP_CAL_HZ) / CAL_SR
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.sin(w * i)
  for (let o = 0; o < n; o += 128) tc.process([x.subarray(o, Math.min(n, o + 128))], Math.min(128, n - o))
  // Fundamental over a whole number of cycles in the settled second half.
  const per = CAL_SR / TAPE_COMP_CAL_HZ
  const from = Math.round(n / 2)
  const len = Math.floor(Math.floor((n - from) / per) * per)
  let re = 0
  let im = 0
  for (let i = from; i < from + len; i++) { re += x[i] * Math.sin(w * i); im += x[i] * Math.cos(w * i) }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / len)
}

/**
 * The threshold (dBFS) at which a steady 55 Hz tone peaking at `peakDb` loses
 * exactly `reductionDb` of its fundamental — the knob's calibration, same idea
 * as TAPE's "dB off the selection's peak". SOLVED BY SIMULATION, not from the
 * static curve: a 1 ms attack follows the tone's own ripple, so the detector
 * reads a low tone ABOVE its RMS and the closed form undershot (3 dB asked,
 * 4.8 taken). Scale-invariant (the stage is homogeneous in dB), so the solve is
 * one offset per knob value, memoised.
 */
export function tapeCompThresholdDb(reductionDb, peakDb, voicing) {
  const r = Math.max(0, Number(reductionDb) || 0)
  if (!(r > 0)) return peakDb + 120
  const key = `${JSON.stringify(voicing)}|${r.toFixed(4)}`
  let off = calCache.get(key)
  if (off === undefined) {
    let lo = -60 // threshold re peak: deep cut
    let hi = 6 // nothing cut
    for (let k = 0; k < 28; k++) {
      const mid = 0.5 * (lo + hi)
      if (-toneLossDb(voicing, mid) > r) lo = mid
      else hi = mid
    }
    off = 0.5 * (lo + hi)
    calCache.set(key, off)
  }
  return peakDb + off
}
