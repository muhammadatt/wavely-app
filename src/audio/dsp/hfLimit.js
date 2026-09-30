/**
 * High-frequency limiting — the two stages behind the HF Limiter plugin.
 *
 * Kept apart from the worklet so the stages can be embedded elsewhere later
 * (the HF Softener's chain, or after a harmonic-generating saturator in the
 * EL Fatso mould) without taking the plugin's wrapper with them. Each stage is
 * block-based, owns its per-channel state, and is BIT-TRANSPARENT BELOW
 * THRESHOLD: both write `dry + correction`, and the correction is exactly zero
 * until something crosses the line. That is the property the HF Softener was
 * built around, and it is what lets a limiter sit on a whole file without
 * touching the parts that did not need it.
 *
 * ── SHELF: a lookahead dynamic shelf (HiFal, Limiter 6's HF stage, Fatso TC) ──
 *
 *   lp[n] = FIR(x)[n − D]    zero-phase lowpass, a one-octave raised-cosine
 *                            transition centred on the corner
 *   h[n]  = x[n − D] − lp[n]                     the band above the corner
 *   y     = x + (g − 1)·h  (both delayed)        = g·x + (1 − g)·lp
 *
 * ⚠ THE SPLIT IS LINEAR-PHASE ON PURPOSE, AND IT WAS NOT THE FIRST ONE. A
 * one-pole split (1 − LP1) is exact but leaks: at full depth it could take a
 * sine an octave above a 5 kHz corner down only ~5 dB, which is not a limiter.
 * A steeper IIR split crosses −180° of phase above the corner and the blend
 * then notches or bumps. With a zero-phase H the cut is g + (1 − g)·H(f), H
 * real in [0, 1] — monotone at every depth, never below its own floor, as
 * steep as the taps allow — and h is EXACTLY the band that gets turned down.
 *
 * That last part is what lets the detector read h itself. The gain is computed
 * like `LookaheadLimiter` (centred running min of the required gain, then a
 * triangular smoother of the same half-width), so the band's peaks are held at
 * the threshold with no overshoot — the proof is in lookaheadLimiter.js and
 * carries over because the output band is g·h exactly. A one-pole release only
 * ever holds the gain DOWN longer, which keeps the guarantee. The gain is
 * linked across channels, so a stereo image does not wander. Range is a floor
 * on g, and below the floor the guarantee is traded for not lisping.
 *
 * Latency is D (the FIR's centre) + 2L (the lookahead), with D = L.
 *
 * ── WARM: the same stage on a one-pole split (EL7 Fatso "Warmth") ─────────
 *
 *   lp = LP1(x[n − D])       bilinear one-pole at the corner, minimum phase
 *   h  = x[n − D] − lp       an exact first-order high-pass
 *   y  = g·x + (1 − g)·lp    a 6 dB/oct shelf that starts an octave or more
 *                            below the corner and never reaches a floor
 *
 * This is the split rejected above for being too gentle to LIMIT — and it is
 * what the Fatso does. Measured on a Warmth 7 bounce, the cut is g·x + (1−g)·LP1
 * at ~2.25 kHz to 0.34 dB rms across every depth, and its group delay moves
 * with g exactly as this blend's does. So it ships as a second shape, not as a
 * replacement: TIGHT holds a band at a ceiling, WARM tilts the top down the way
 * tape and the Fatso do. The band guarantee still holds — h is scaled by g
 * exactly — but h is now everything above ~corner/2 at 6 dB/oct, so a WARM
 * threshold reads more of the spectrum than a TIGHT one at the same corner.
 * It runs D samples late like the FIR does, so the two shapes share one
 * latency and switching between them never moves the audio.
 *
 * ── RELEASE: one stage, or two ─────────────────────────────────────────────
 *
 * With Tail > 0 the gain is
 *
 *   s  = slow follower of gl: falls with `tailChargeMs`, rises with Tail
 *   g  = instant down to min(gl, s), up toward it with Release
 *
 * so a click charges `s` hardly at all and recovers at the Release speed,
 * while a sustained bright passage charges it and leaves a slow tail — the
 * program dependence of an opto or a dual-time-constant release. g ≤ s and
 * g ≤ gl throughout, so the no-overshoot guarantee is untouched. Tail 0 is the
 * single-stage release, bit for bit.
 *
 * ── ACCEL: an acceleration limiter (Limen) ─────────────────────────────────
 *
 * A sine of amplitude a at frequency f has second difference a·(2 sin(πf/fs))²,
 * so bounding the waveform's ACCELERATION is a level limit that tightens at
 * 12 dB/oct up the spectrum: low frequencies can be loud, bright transients
 * cannot. That is the whole idea, and it needs no filter bank and no envelope
 * — it acts inside the cycle, so there is no attack to get past.
 *
 * Bounding acceleration directly (a clamped double integrator) is a bang-bang
 * servo and rings. This is built the stable way round:
 *
 *   v[n] = x[n] − x[n−1]                              input velocity
 *   w[n] = w[n−1] + clamp(v[n] − w[n−1], ±A)          slew-limited velocity
 *   e[n] = (1 − k)·e[n−1] + (w[n] − v[n])             leaky displacement error
 *   y[n] = x[n] + e[n]
 *
 * y's velocity is w − k·e, so its acceleration is bounded by A plus the leak,
 * and every piece is first-order stable. The leak makes the correction a
 * high-passed signal (corner a quarter of the limit corner), so it cannot
 * accumulate a DC or low-frequency offset. When nothing clamps, w = v exactly
 * and e decays to exactly zero.
 *
 * It is a waveform shaper and makes harmonics, so it runs 4x oversampled — but
 * ONLY THE CORRECTION is resampled. The dry path is a whole-sample delay, so
 * below threshold the stage is still bit-transparent; the resampling filters
 * never touch the audio unless there is something to add back.
 */

import { RunningMin, Boxcar } from './lookaheadLimiter.js'
import { Oversampler, DelayLine, COMPRESSOR_OVERSAMPLE } from './oversample.js'

/** The accel stage's resampling profile; its round trip is the stage's latency. */
export const ACCEL_OVERSAMPLE = COMPRESSOR_OVERSAMPLE

/** Accel stage latency, base-rate samples. */
export const ACCEL_LATENCY_SAMPLES = ACCEL_OVERSAMPLE.latencySamples

/** Shelf lookahead, seconds. The gain's share of the latency is twice this. */
export const SHELF_LOOKAHEAD_S = 0.001

/** Width of the split's transition, octaves, centred on the corner. */
export const SPLIT_TRANSITION_OCT = 1

/** Kaiser window beta for the split. Lower smears less; higher ripples less. */
const SPLIT_KAISER_BETA = 5

function shelfHalfWidth(sampleRate) {
  return Math.max(1, Math.round(SHELF_LOOKAHEAD_S * sampleRate))
}

/** Shelf stage latency at a sample rate, samples: the FIR's centre plus 2L. */
export function shelfLatencySamples(sampleRate) {
  return 3 * shelfHalfWidth(sampleRate)
}

/** The accel correction's leak corner, as a fraction of the limit corner. */
export const ACCEL_LEAK_RATIO = 0.25

/** Gains this close to 1 are 1. Keeps a release from parking one ulp short. */
const UNITY_SNAP = 1e-7

/** Below this the accel error is zero, so it cannot linger as denormals. */
const ERROR_FLOOR = 1e-20

function besselI0(x) {
  let sum = 1, term = 1
  for (let k = 1; k < 50; k++) {
    term *= (x / (2 * k)) ** 2
    sum += term
    if (term < 1e-12 * sum) break
  }
  return sum
}

/** The ideal split: 1 below the transition, 0 above, raised cosine in log f. */
function splitTarget(f, cornerHz) {
  const half = SPLIT_TRANSITION_OCT / 2
  const oct = Math.log2(Math.max(f, 1e-9) / cornerHz)
  if (oct <= -half) return 1
  if (oct >= half) return 0
  return 0.5 + 0.5 * Math.cos((Math.PI * (oct + half)) / SPLIT_TRANSITION_OCT)
}

const tapCache = new Map()

/**
 * The split's lowpass taps, zero-phase, index 0..2D with the centre at D.
 * Frequency-sampled from `splitTarget`, Kaiser-windowed, and normalised to
 * exactly unity at DC, so the band `h` carries no DC and no bass.
 */
export function splitTaps(sampleRate, cornerHz) {
  const D = shelfHalfWidth(sampleRate)
  const key = `${sampleRate}:${cornerHz}`
  const hit = tapCache.get(key)
  if (hit) return hit
  const GRID = 4096
  const target = new Float64Array(GRID + 1)
  for (let j = 0; j <= GRID; j++) target[j] = splitTarget((j / GRID) * sampleRate / 2, cornerHz)
  const taps = new Float64Array(2 * D + 1)
  const i0b = besselI0(SPLIT_KAISER_BETA)
  let sum = 0
  for (let k = 0; k <= D; k++) {
    // h[k] = (1/π)∫₀^π H(ω)cos(ωk)dω, trapezoidal on the grid.
    let acc = 0
    for (let j = 0; j <= GRID; j++) {
      const w = (j === 0 || j === GRID) ? 0.5 : 1
      acc += w * target[j] * Math.cos((Math.PI * j * k) / GRID)
    }
    const r = k / D
    const win = besselI0(SPLIT_KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b
    const v = (acc / GRID) * win
    taps[D + k] = v
    taps[D - k] = v
    sum += k === 0 ? v : 2 * v
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum
  if (tapCache.size > 64) tapCache.clear()
  tapCache.set(key, taps)
  return taps
}

/** The split lowpass's (real, zero-phase) response at each frequency. */
export function splitResponse(sampleRate, cornerHz, freqsHz) {
  const taps = splitTaps(sampleRate, cornerHz)
  const D = (taps.length - 1) / 2
  return freqsHz.map(f => {
    const w = (2 * Math.PI * f) / sampleRate
    let acc = taps[D]
    for (let k = 1; k <= D; k++) acc += 2 * taps[D + k] * Math.cos(w * k)
    return acc
  })
}

/** One-pole lowpass (bilinear, prewarped) — the WARM split. */
export function onePoleLowpass(sampleRate, cornerHz) {
  const K = Math.tan((Math.PI * Math.min(cornerHz, 0.49 * sampleRate)) / sampleRate)
  const b0 = K / (1 + K)
  return { b0, a1: (K - 1) / (K + 1) }
}

/**
 * The shelf's magnitude response at a gain, dB — |g + (1 − g)·H(f)|, with H
 * the TIGHT split's zero-phase FIR or the WARM split's one-pole. Exactly the
 * filter the stage runs, so the panel draws what is being applied.
 */
export function shelfResponseDb(sampleRate, cornerHz, gain, freqsHz, shape = 'tight') {
  if (shape === 'warm') {
    const { b0, a1 } = onePoleLowpass(sampleRate, cornerHz)
    return freqsHz.map(f => {
      const w = (2 * Math.PI * f) / sampleRate
      // LP1(e^jw) = b0(1 + e^-jw) / (1 + a1·e^-jw)
      const nr = b0 * (1 + Math.cos(w)), ni = -b0 * Math.sin(w)
      const dr = 1 + a1 * Math.cos(w), di = -a1 * Math.sin(w)
      const den = dr * dr + di * di
      const re = gain + (1 - gain) * ((nr * dr + ni * di) / den)
      const im = (1 - gain) * ((ni * dr - nr * di) / den)
      return 10 * Math.log10(Math.max(1e-12, re * re + im * im))
    })
  }
  return splitResponse(sampleRate, cornerHz, freqsHz)
    .map(H => 20 * Math.log10(Math.max(1e-6, Math.abs(gain + (1 - gain) * H))))
}

/**
 * How fast a sustained cut charges the Tail stage, ms — REASONED, NOT FITTED:
 * long enough that a single click (a few ms) barely charges it, short enough
 * that a syllable of bright sibilance does.
 *
 * ⚠ THE FATSO BOUNCE COULD NOT FIT IT, because it does not need a second
 * stage. Fitted against the Warmth 7 gain trajectory, a single 36 ms release
 * scored 1.16 dB rms and the best two-stage point 1.17: the descent drove the
 * charge out to 315 ms, where the slow stage never engages. What looks like a
 * two-stage release on its gain-reduction trace is a one-pole release in
 * LINEAR gain read in dB — from −14 dB it is at −4.4 dB after 25 ms and takes
 * another 75 ms to reach −0.4. Tail is a program-dependence control of its
 * own, not part of the Fatso match.
 */
export const TAIL_CHARGE_MS = 50

/**
 * The acceleration bound for a limit of `thresholdLin` at `cornerHz`, at the
 * rate the stage runs. A sine at the corner and the threshold sits exactly on
 * it; an octave up it is limited 12 dB lower.
 */
export function accelLimitFor(thresholdLin, cornerHz, rate) {
  const s = 2 * Math.sin(Math.PI * Math.min(cornerHz, 0.49 * rate) / rate)
  return thresholdLin * s * s
}

export class ShelfLimiterStage {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    const L = shelfHalfWidth(sampleRate)
    this.L = L
    this.D = L
    this.latencySamples = shelfLatencySamples(sampleRate)
    this.min = new RunningMin(2 * L + 1)
    this.box1 = new Boxcar(L + 1)
    this.box2 = new Boxcar(L + 1)
    this.channels = 0
    this.hist = [] // last 2D+1 inputs, doubled so the FIR reads a flat window
    this.histPos = 0
    this.xDelay = []
    this.hDelay = []
    this.band = []
    this.lpX1 = []
    this.lpY1 = []
    this.gain = 1
    this.slow = 1
    this.minGain = 1
    this.setParams({ cornerHz: 5000, thresholdLin: 0.1, floorLin: 0.25, releaseMs: 60 })
  }

  setParams({
    cornerHz, thresholdLin, floorLin, releaseMs,
    shape = 'tight', tailMs = 0, tailChargeMs = TAIL_CHARGE_MS,
  }) {
    const coeff = ms => Math.exp(-1 / (Math.max(1, ms) * 1e-3 * this.sampleRate))
    this.cornerHz = cornerHz
    this.thresholdLin = thresholdLin
    this.floorLin = floorLin
    this.releaseCoeff = coeff(releaseMs)
    this.warm = shape === 'warm'
    this.taps = splitTaps(this.sampleRate, cornerHz)
    const lp = onePoleLowpass(this.sampleRate, cornerHz)
    this.lpB0 = lp.b0
    this.lpA1 = lp.a1
    this.tail = tailMs > 0
    this.tailCoeff = coeff(tailMs)
    this.chargeCoeff = coeff(tailChargeMs)
    if (!this.tail) this.slow = 1
  }

  ensureChannels(n) {
    const len = 2 * this.D + 1
    for (let ch = this.channels; ch < n; ch++) {
      this.hist.push(new Float64Array(2 * len))
      this.xDelay.push(new DelayLine(2 * this.L))
      this.hDelay.push(new DelayLine(2 * this.L))
      this.band.push(new Float64Array(2)) // [x, h] at the FIR centre
      this.lpX1.push(0)
      this.lpY1.push(0)
    }
    if (n > this.channels) this.channels = n
  }

  /** In place over `n` samples of every channel in `bufs`. */
  process(bufs, n) {
    const nCh = bufs.length
    this.ensureChannels(nCh)
    const taps = this.taps
    const D = this.D
    const len = 2 * D + 1
    const T = this.thresholdLin
    const floor = this.floorLin
    const rel = this.releaseCoeff
    const warm = this.warm
    const b0 = this.lpB0, a1 = this.lpA1
    const tail = this.tail, tailC = this.tailCoeff, chargeC = this.chargeCoeff
    let s = this.slow
    let g = this.gain
    let minGain = this.minGain
    let pos = this.histPos
    for (let i = 0; i < n; i++) {
      // Split: the band h at the FIR's centre, D samples back.
      let m = 0
      for (let ch = 0; ch < nCh; ch++) {
        const hist = this.hist[ch]
        const x = bufs[ch][i]
        hist[pos] = x
        hist[pos + len] = x
        // hist[pos + 1 .. pos + len] is the window, oldest first.
        const o = pos + 1
        const xc = hist[o + D]
        // The one-pole runs every sample in both shapes, so a switch to WARM
        // starts from a settled filter rather than from zero.
        let lp = b0 * (xc + this.lpX1[ch]) - a1 * this.lpY1[ch]
        this.lpX1[ch] = xc
        this.lpY1[ch] = lp > -ERROR_FLOOR && lp < ERROR_FLOOR ? 0 : lp
        if (!warm) {
          lp = 0
          for (let k = 0; k < len; k++) lp += taps[k] * hist[o + k]
        }
        const h = xc - lp
        this.band[ch][0] = xc
        this.band[ch][1] = h
        const a = h < 0 ? -h : h
        if (a > m) m = a
      }
      pos = pos + 1 === len ? 0 : pos + 1

      let req = m > T ? T / m : 1
      if (req < floor) req = floor
      const gl = this.box2.push(this.box1.push(this.min.push(req)))
      let target = gl
      if (tail) {
        // The slow stage: charges only on a sustained cut, lets go over Tail.
        s = gl < s ? gl - (gl - s) * chargeC : gl - (gl - s) * tailC
        if (1 - s < UNITY_SNAP) s = 1
        if (s < target) target = s
      }
      // Instant down (the lookahead already shaped it), one-pole back up.
      g = target < g ? target : target - (target - g) * rel
      if (1 - g < UNITY_SNAP) g = 1
      if (g < minGain) minGain = g

      for (let ch = 0; ch < nCh; ch++) {
        const xd = this.xDelay[ch].push(this.band[ch][0])
        const hd = this.hDelay[ch].push(this.band[ch][1])
        bufs[ch][i] = g === 1 ? xd : xd + (g - 1) * hd
      }
    }
    this.histPos = pos
    this.slow = s
    this.gain = g
    this.minGain = minGain
  }

  /** Deepest gain since the last call, linear; resets the hold. */
  takeMinGain() {
    const m = this.minGain
    this.minGain = this.gain
    return m
  }
}

export class AccelLimiterStage {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    this.rate = sampleRate * ACCEL_OVERSAMPLE.factor
    this.latencySamples = ACCEL_LATENCY_SAMPLES
    this.channels = 0
    this.os = []
    this.dry = []
    this.xPrev = []
    this.w = []
    this.e = []
    this.corr = new Float32Array(128)
    this.clamped = 0
    this.total = 0
    this.enabled = true
    this.setParams({ cornerHz: 5000, thresholdLin: 0.1 })
  }

  /**
   * `enabled: false` leaves the stage a pure delay of the same length, so
   * switching it in and out never moves the plugin's latency.
   */
  setParams({ cornerHz, thresholdLin, enabled = true }) {
    if (enabled && !this.enabled) {
      // Coming back in: start from rest rather than from whatever the
      // oversamplers and integrators held when it went out.
      for (let ch = 0; ch < this.channels; ch++) {
        this.os[ch].reset()
        this.xPrev[ch] = 0
        this.w[ch] = 0
        this.e[ch] = 0
      }
    }
    this.enabled = enabled
    this.A = accelLimitFor(thresholdLin, cornerHz, this.rate)
    this.leak = 1 - Math.exp((-2 * Math.PI * ACCEL_LEAK_RATIO * cornerHz) / this.rate)
  }

  ensureChannels(n) {
    for (let ch = this.channels; ch < n; ch++) {
      this.os.push(new Oversampler(ACCEL_OVERSAMPLE))
      this.dry.push(new DelayLine(this.latencySamples))
      this.xPrev.push(0)
      this.w.push(0)
      this.e.push(0)
    }
    if (n > this.channels) this.channels = n
  }

  /** In place over `n` samples of every channel in `bufs`. */
  process(bufs, n) {
    this.ensureChannels(bufs.length)
    if (this.corr.length < n) this.corr = new Float32Array(n)
    if (!this.enabled) {
      for (let ch = 0; ch < bufs.length; ch++) {
        const buf = bufs[ch]
        const dry = this.dry[ch]
        for (let i = 0; i < n; i++) buf[i] = dry.push(buf[i])
      }
      return
    }
    const A = this.A
    const keep = 1 - this.leak
    let clamped = 0
    for (let ch = 0; ch < bufs.length; ch++) {
      const buf = bufs[ch]
      const hi = this.os[ch].up(buf, n)
      const len = n * ACCEL_OVERSAMPLE.factor
      let xPrev = this.xPrev[ch], w = this.w[ch], e = this.e[ch]
      for (let i = 0; i < len; i++) {
        const x = hi[i]
        const v = x - xPrev
        xPrev = x
        const dv = v - w
        if (dv > A) { w += A; clamped++ } else if (dv < -A) { w -= A; clamped++ } else w = v
        e = e * keep + (w - v)
        if (e < ERROR_FLOOR && e > -ERROR_FLOOR) e = 0
        hi[i] = e
      }
      this.xPrev[ch] = xPrev
      this.w[ch] = w
      this.e[ch] = e
      this.os[ch].down(this.corr, n)
      const dry = this.dry[ch]
      const corr = this.corr
      for (let i = 0; i < n; i++) buf[i] = dry.push(buf[i]) + corr[i]
    }
    this.clamped += clamped
    this.total += n * ACCEL_OVERSAMPLE.factor * bufs.length
  }

  /** Fraction of high-rate samples clamped since the last call; resets. */
  takeActivity() {
    const a = this.total > 0 ? this.clamped / this.total : 0
    this.clamped = 0
    this.total = 0
    return a
  }
}
