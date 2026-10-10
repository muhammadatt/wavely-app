/**
 * Tape HF shelf — the top end SAGGING with level, the way a tape machine
 * loses high-frequency headroom when it is hit hard (self-erasure), rather
 * than being caught at a ceiling.
 *
 * It is the other kind of level-dependent shelf from `ShelfLimiterStage`
 * (the HF Limiter's, and PHAT*SS's FATSO), and differs on every axis that
 * matters for how it sounds:
 *
 *   detector  ENERGY of a pre-emphasised band (mean square through a one-pole
 *             high-pass at the tape speed's emphasis corner), smoothed —
 *             not the band's instantaneous peak
 *   timing    NO LOOKAHEAD: a few ms of attack, a slower release. An onset
 *             gets through bright and sustained brightness darkens — the
 *             opposite of a lookahead limiter, which cuts the attack first.
 *             (The one measured clue: the Studer A800 renders' hit onsets
 *             were BRIGHTER than ours.)
 *   law       gentle — `slope` dB of cut per dB over threshold (no ceiling),
 *             entered through a quadratic knee, capped at `rangeDb`
 *   response  the corner SLIDES DOWN as it cuts: cornerMaxHz at rest,
 *             `cutPerOctDb` dB of cut per octave lower, never below
 *             cornerMinHz — so a hot passage loses more of the top AND the
 *             loss reaches further down, the "sag"
 *
 * The audio path is the WARM shelf, `y = g·x + (1 − g)·LP1(x; fc)`, with both
 * g and fc moving: linear for any fixed pair, so the nonlinearity is in the
 * control signal and no intermodulation is made. Zero latency. Bit-transparent
 * while the cut is 0 and when off (the one-pole keeps running so a cut starts
 * from a settled filter). Linked across channels.
 *
 * Every constant here is REASONED, not fitted — there is no reference for it
 * (the owner does not want an A800 match) — and is set per tape speed in
 * phatassParams.js (`TAPE_SPEEDS`).
 */

import { onePoleLowpass } from './hfLimit.js'

const ERROR_FLOOR = 1e-20
/** Coefficients follow the corner every this many samples. */
const COEFF_STRIDE = 8
const LN10_OVER_20 = Math.LN10 / 20

export class TapeHfShelf {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.latencySamples = 0
    this.on = false
    this.channels = 0
    this.detX1 = []
    this.detY1 = []
    this.lpX1 = []
    this.lpY1 = []
    this.env = 0
    this.cutDb = 0
    this.maxCutDb = 0
  }

  /**
   * @param {null | { detectHz, cornerMaxHz, cornerMinHz, cutPerOctDb, thresholdDb,
   *   slope, kneeDb, rangeDb, attackMs, releaseMs }} p  null switches it off.
   */
  setParams(p) {
    if (!p || !(p.rangeDb > 0)) {
      this.on = false
      return
    }
    const sr = this.sampleRate
    const coeff = ms => Math.exp(-1 / (Math.max(0.1, ms) * 1e-3 * sr))
    const det = onePoleLowpass(sr, p.detectHz)
    this.detB0 = det.b0
    this.detA1 = det.a1
    this.cornerMaxHz = p.cornerMaxHz
    this.cornerMinHz = p.cornerMinHz
    this.cutPerOctDb = p.cutPerOctDb
    this.thresholdDb = p.thresholdDb
    this.slope = p.slope
    this.kneeDb = Math.max(0, p.kneeDb ?? 0)
    this.rangeDb = p.rangeDb
    this.attack = coeff(p.attackMs)
    this.release = coeff(p.releaseMs)
    if (!this.on) {
      // Coming back on: the envelope restarts from rest rather than from
      // whatever it held when it was switched off.
      this.env = 0
      this.cutDb = 0
    }
    this.on = true
    this.setCorner(this.cornerFor(this.cutDb))
  }

  /** The corner at a given cut, Hz. */
  cornerFor(cutDb) {
    const hz = this.cornerMaxHz * Math.pow(2, -cutDb / this.cutPerOctDb)
    return hz < this.cornerMinHz ? this.cornerMinHz : hz
  }

  setCorner(hz) {
    const c = onePoleLowpass(this.sampleRate, hz)
    this.lpB0 = c.b0
    this.lpA1 = c.a1
  }

  /** The static law: cut (dB) for a detector level (dB re threshold). */
  cutForOver(over) {
    const K = this.kneeDb, s = this.slope
    let cut
    if (K > 0 && over > -K / 2 && over < K / 2) cut = (s * (over + K / 2) ** 2) / (2 * K)
    else cut = over > 0 ? s * over : 0
    return cut > this.rangeDb ? this.rangeDb : cut
  }

  ensureChannels(n) {
    for (let ch = this.channels; ch < n; ch++) {
      this.detX1.push(0); this.detY1.push(0)
      this.lpX1.push(0); this.lpY1.push(0)
    }
    if (n > this.channels) this.channels = n
  }

  /** In place over `n` samples of every channel in `bufs`. */
  process(bufs, n) {
    if (!this.on) return
    const nCh = bufs.length
    this.ensureChannels(nCh)
    const db0 = this.detB0, da1 = this.detA1
    const att = this.attack, rel = this.release
    let env = this.env
    let cut = this.cutDb
    let maxCut = this.maxCutDb
    for (let i = 0; i < n; i++) {
      if (i % COEFF_STRIDE === 0) this.setCorner(this.cornerFor(cut))
      const b0 = this.lpB0, a1 = this.lpA1
      // Detector: mean square of the emphasised band across channels.
      let ms = 0
      for (let ch = 0; ch < nCh; ch++) {
        const x = bufs[ch][i]
        let d = db0 * (x + this.detX1[ch]) - da1 * this.detY1[ch]
        if (d > -ERROR_FLOOR && d < ERROR_FLOOR) d = 0
        this.detX1[ch] = x
        this.detY1[ch] = d
        const h = x - d
        ms += h * h
      }
      ms /= nCh
      env = ms + (env - ms) * (ms > env ? att : rel)
      cut = env > 1e-14 ? this.cutForOver(10 * Math.log10(env) - this.thresholdDb) : 0
      if (cut > maxCut) maxCut = cut
      const g = Math.exp(-cut * LN10_OVER_20)
      for (let ch = 0; ch < nCh; ch++) {
        const x = bufs[ch][i]
        let lp = b0 * (x + this.lpX1[ch]) - a1 * this.lpY1[ch]
        if (lp > -ERROR_FLOOR && lp < ERROR_FLOOR) lp = 0
        this.lpX1[ch] = x
        this.lpY1[ch] = lp
        if (cut > 0) bufs[ch][i] = g * x + (1 - g) * lp
      }
    }
    this.env = env
    this.cutDb = cut
    this.maxCutDb = maxCut
  }

  /** Deepest cut since the last call, dB; resets the hold. */
  takeMaxCutDb() {
    const m = this.maxCutDb
    this.maxCutDb = this.cutDb
    return m
  }
}
