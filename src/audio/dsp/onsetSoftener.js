/**
 * ONSET SOFTENER — the HF Limiter's Transient detector, applied as a gain to
 * the WHOLE signal: a transient designer's "attack down", for PHAT*SS.
 *
 *   d    = the input, linked across channels, through an 80 Hz–4 kHz detector
 *          band (rumble and sibilance do not trigger it)
 *   f    = peak follower of |d|      attack ~instant, release 40 ms
 *   s    = slow follower OF f        attack 30 ms,    release 40 ms
 *   rise = 20·log10(f / s) dB        ~0 on anything steady; jumps on onsets
 *   cut  = clamp(amount·(rise − 3), 0, 18) dB, gated below the voice level,
 *          through a lookahead running min + triangle (the shelf's smoother)
 *   out  = x · g                     broadband, every channel the same gain
 *
 * It reacts to how SUDDENLY the signal rises, not how loud it is, so every
 * syllable onset is shaved for the ~30 ms the slow follower takes to catch up
 * — whether the syllable is loud or soft — and steady vowels pass untouched.
 * It is a gain, never a waveshaper: it adds no harmonics, and it can only
 * lower the level, so it cannot raise a peak.
 *
 * WHY THE HF LIMITER'S CONSTANTS ARE NOT REUSED AS-IS. The Transient knob runs
 * its peak follower with a 20 ms release on a band above 2 kHz, where the
 * waveform is fast. On the whole signal the follower rides a voice's
 * FUNDAMENTAL (5–12 ms period) and a 20 ms release ripples on it. Measured on
 * narration (Southern Sunrise, 80 Hz–4 kHz detector), rise percentiles over
 * voiced samples:
 *
 *   f release / s attack   p90     p99     p99.9
 *   20 / 10 ms             1.12    3.62    8.26
 *   40 / 10 ms             0.67    3.27    7.32   ← release shipped
 *   60 / 10 ms             0.46    3.06    6.99
 *   40 / 20 ms             1.15    4.52   10.27
 *
 * so a 40 ms release keeps the steady-state ripple well under the 3 dB floor.
 *
 * ⚠ THE SLOW ATTACK IS 30 ms, NOT THE TRANSIENT KNOB'S 10, because a syllable
 * is not a click: it rises over 10–30 ms, a 10 ms slow follower keeps up with
 * it, and the detector reads little rise. Swept on the same narration at full
 * Soften (16 onsets; "steady" = 269 loud 10 ms frames within 1.5 dB of their
 * neighbours 30 ms either side, the material that must NOT move):
 *
 *   slow attack   onset crest   first 30 ms   steady   whole-file rms
 *   10 ms         −0.68         −0.29         −0.01    −0.07
 *   20 ms         −1.18         −0.68         −0.01    −0.13
 *   30 ms         −1.47         −0.97         −0.01    −0.18   ← shipped
 *   50 ms         −1.73         −1.35         −0.03    −0.25
 *
 * Longer catches more of each onset but shaves a longer stretch of the
 * syllable; 30 ms is reasoned as the middle, not auditioned. A release of 80 ms
 * instead of 40 weakened every row by about a third.
 *
 * ⚠ THE KNOB IS A FRACTION OF THE ONSET, NOT A CAP ON IT. The HF Limiter's law
 * is a fixed 0.5 dB per dB with the knob as a ceiling; carried over, most
 * syllable onsets rise only a few dB over the floor, their cut never reached
 * even the second step's cap, and on narration Soften 2 through 10 measured
 * IDENTICAL (peak −2.17 dB at every setting). Here `amount` (0–1) is the share
 * of each onset's rise above the floor that is removed: 0.5 halves the jump,
 * 1 flattens it to the settled level. `ONSET_MAX_CUT_DB` is only a safety cap.
 * Reasoned and measured on one narration; not auditioned at the time it was built.
 *
 * GATE: only onsets whose detector peak reaches within `ONSET_GATE_BELOW_DB` of
 * the file's voice level (gated RMS) are softened, fading in over the next
 * 6 dB, so a cough in room tone or the noise floor never pumps.
 *
 * LATENCY is 2L (L = `ONSET_LOOKAHEAD_MS`), constant. At amount 0 the required
 * gain is exactly 1 everywhere, the smoother's running sums of exact ones stay
 * exactly one, and the stage is a pure delay — bit for bit.
 */

import { RunningMin, Boxcar } from './lookaheadLimiter.js'
import { DelayLine } from './oversample.js'
import { BiquadCascade, highpass, lowpass } from './biquad.js'

export const ONSET_FAST_ATTACK_MS = 0.1
export const ONSET_SLOW_ATTACK_MS = 30
export const ONSET_RELEASE_MS = 40
export const ONSET_RISE_FLOOR_DB = 3
/**
 * Bench ranges for the three settings PHAT*SS exposes as device fields, so
 * they can be auditioned: the floor, the slow attack, and how far past
 * "flatten" the knob's top may reach (amount > 1 cuts an onset by more than it
 * rose — it dips below the settled level).
 */
export const ONSET_FLOOR_MIN_DB = 0
export const ONSET_FLOOR_MAX_DB = 6
export const ONSET_ATTACK_MIN_MS = 5
export const ONSET_ATTACK_MAX_MS = 100
export const ONSET_AMOUNT_MAX = 3
/** No onset is ever cut deeper than this, whatever the knob. */
export const ONSET_MAX_CUT_DB = 18
export const ONSET_DETECT_LO_HZ = 80
export const ONSET_DETECT_HI_HZ = 4000
/** Detector peaks this far under the voice level (gated RMS) are left alone. */
export const ONSET_GATE_BELOW_DB = 18
/** Lookahead half-width L: the cut is fully down 2L after it starts. */
export const ONSET_LOOKAHEAD_MS = 1.5

const UNITY_SNAP = 1e-7

export function onsetHalfWidth(sampleRate) {
  return Math.max(1, Math.round((ONSET_LOOKAHEAD_MS / 1000) * sampleRate))
}

/** The stage's latency, samples (constant, at any depth). */
export function onsetLatencySamples(sampleRate) {
  return 2 * onsetHalfWidth(sampleRate)
}

export class OnsetSoftener {
  /** `slowAttackMs` / `releaseMs` exist for the measurement scripts; the app uses the defaults. */
  constructor(sampleRate, { slowAttackMs = ONSET_SLOW_ATTACK_MS, releaseMs = ONSET_RELEASE_MS } = {}) {
    this.sampleRate = sampleRate
    const L = onsetHalfWidth(sampleRate)
    this.L = L
    this.latencySamples = 2 * L
    this.min = new RunningMin(2 * L + 1)
    this.box1 = new Boxcar(L + 1)
    this.box2 = new Boxcar(L + 1)
    const co = ms => Math.exp(-1 / (ms * 1e-3 * sampleRate))
    this.fa = co(ONSET_FAST_ATTACK_MS)
    this.sa = co(slowAttackMs)
    this.rel = co(releaseMs)
    this.sections = [highpass(sampleRate, ONSET_DETECT_LO_HZ), lowpass(sampleRate, ONSET_DETECT_HI_HZ)]
    this.det = null
    this.detBuf = []
    this.delays = []
    this.channels = 0
    this.f = 0
    this.s = 0
    this.amount = 0
    this.floorDb = ONSET_RISE_FLOOR_DB
    this.gateLin = 0
    this.minGain = 1
  }

  /**
   * `amount` — share of each onset's rise removed (1 flattens it, above 1 dips
   * below the settled level, up to ONSET_AMOUNT_MAX); `voiceLevelDb` — the
   * file's gated RMS; `floorDb` — rise never cut; `slowAttackMs` — the slow
   * follower's attack. The last two default to the shipped constants.
   */
  setParams({ amount, voiceLevelDb, floorDb, slowAttackMs } = {}) {
    if (Number.isFinite(amount)) this.amount = amount < 0 ? 0 : amount > ONSET_AMOUNT_MAX ? ONSET_AMOUNT_MAX : amount
    if (Number.isFinite(floorDb)) this.floorDb = Math.max(ONSET_FLOOR_MIN_DB, Math.min(ONSET_FLOOR_MAX_DB, floorDb))
    if (Number.isFinite(slowAttackMs)) {
      const ms = Math.max(ONSET_ATTACK_MIN_MS, Math.min(ONSET_ATTACK_MAX_MS, slowAttackMs))
      this.sa = Math.exp(-1 / (ms * 1e-3 * this.sampleRate))
    }
    if (Number.isFinite(voiceLevelDb)) this.gateLin = 10 ** ((voiceLevelDb - ONSET_GATE_BELOW_DB) / 20)
  }

  _ensure(nCh, n) {
    if (nCh !== this.channels) {
      this.det = new BiquadCascade(2, nCh)
      this.det.setSections(this.sections)
      while (this.delays.length < nCh) this.delays.push(new DelayLine(this.latencySamples))
      this.channels = nCh
    }
    while (this.detBuf.length < nCh) this.detBuf.push(new Float64Array(n))
    for (let ch = 0; ch < nCh; ch++) if (this.detBuf[ch].length < n) this.detBuf[ch] = new Float64Array(n)
  }

  /** In place over `n` samples of every channel in `bufs`; output delayed by `latencySamples`. */
  process(bufs, n) {
    const nCh = bufs.length
    this._ensure(nCh, n)
    // The detector always runs, so turning the knob up starts from settled state.
    for (let ch = 0; ch < nCh; ch++) this.det.process(bufs[ch], this.detBuf[ch], n, ch)
    const amount = this.amount
    const floorDb = this.floorDb
    const gate = this.gateLin
    const fa = this.fa, sa = this.sa, rel = this.rel
    let f = this.f, s = this.s, minG = this.minGain
    for (let i = 0; i < n; i++) {
      let m = 0
      for (let ch = 0; ch < nCh; ch++) {
        const v = this.detBuf[ch][i]
        const a = v < 0 ? -v : v
        if (a > m) m = a
      }
      f = m > f ? m + (f - m) * fa : m + (f - m) * rel
      s = f > s ? f + (s - f) * sa : f + (s - f) * rel
      let req = 1
      if (amount > 0 && f > gate && s > 0) {
        let cutDb = amount * (20 * Math.log10(f / s) - floorDb)
        if (cutDb > 0) {
          if (cutDb > ONSET_MAX_CUT_DB) cutDb = ONSET_MAX_CUT_DB
          // Fade in over the 6 dB above the gate, so the gate cannot click.
          const over = 20 * Math.log10(f / gate)
          if (over < 6) cutDb *= over / 6
          req = Math.pow(10, -cutDb / 20)
        }
      }
      let g = this.box2.push(this.box1.push(this.min.push(req)))
      if (1 - g < UNITY_SNAP) g = 1
      if (g < minG) minG = g
      for (let ch = 0; ch < nCh; ch++) {
        const d = this.delays[ch].push(bufs[ch][i])
        bufs[ch][i] = g === 1 ? d : d * g
      }
    }
    if (f < 1e-20) f = 0
    if (s < 1e-20) s = 0
    this.f = f
    this.s = s
    this.minGain = minG
  }

  /** Deepest gain since the last call, linear (1 = untouched). */
  takeMinGain() {
    const m = this.minGain
    this.minGain = 1
    return m
  }
}
