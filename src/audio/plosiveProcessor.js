/**
 * Plosive Tamer — worklet kernel.
 *
 * Two kinds of plosive trouble, two stages, one lookahead:
 *
 *   POP    a P or B's air hitting the capsule: a thump below ~150 Hz that the
 *          voice itself does not make. Detected as the low band (below Freq,
 *          4th-order) JUMPING `popRiseDb` within `popRiseMs` and, within
 *          `popRiseWindowMs` of that jump, standing `popRatioDb` over the voice
 *          band above it (from 2 × Freq to 3 kHz). Then, for as long as the low
 *          band still stands over the voice (less `popHysteresisDb`, at most
 *          `popMaxMs`), it is cut by how far it stands over, up to Depth (no
 *          new pop opens within `popRefractoryMs` of the last):
 *
 *            cut = min(Depth, low − voice − ratio)         dB
 *            y   = g·x + (1 − g)·HP2(x)                    a dynamic high-pass
 *
 *          ⚠ THE RISE TEST IS WHAT SPARES A DEEP VOICE. A held "oo" from a low
 *          male voice can put more energy under 120 Hz than over 240 — the
 *          ratio test alone would cut it for the length of the vowel. Its low
 *          band never JUMPS, though, so it never opens a pop. A vowel onset
 *          after silence does jump, and the ratio test spares that: its voice
 *          band arrives with it.
 *
 *   BURST  the T, K and P RELEASE: a short top-end burst straight out of a
 *          stop's silence. Ported from the De-Esser's hidden "Plosives"
 *          (where it lowered the de-ess thresholds inside a window and lifted
 *          the lisp guard): the detection is the same, constant for constant —
 *          a closure (the whole band ≥ `burstClosureDb` under the held voice
 *          for `burstClosureMinMs`–`MaxMs`: a stop's silence, not a pause),
 *          then within `burstOnsetWindowMs` the top band (4 kHz high-pass, peak
 *          follower) rising ≥ the Sensitivity's dB in `burstRiseMs`, which an
 *          "s" building over 20–40 ms does not. That opens a window of Length
 *          (the last `burstFadeMs` a fade), closed early where the voice band
 *          leads — a vowel onset, or the T's own vowel. Here the window drives
 *          a cut of its own:
 *
 *            cut = Depth · window                          dB
 *            y   = g·x + (1 − g)·LP2(x)                    a dynamic low-pass
 *
 *          ⚠ Known false positive, inherited: an "s" that starts ABRUPTLY
 *          (≤ ~5 ms) after 15–200 ms of silence reads as a burst. Real "s"
 *          onsets build over 20–40 ms and are not caught.
 *
 * ── Gain path ──────────────────────────────────────────────────────────────
 *
 * Both required gains run through `LookaheadLimiter`'s construction — a
 * centred running min over 2L + 1 samples, then a triangular smoother of the
 * same half-width — so the cut is fully in place by the sample that needed it
 * and never smaller than asked for there (the proof is in lookaheadLimiter.js),
 * then an upward-only one-pole release. The audio runs 2L late to match:
 * PLOSIVE_LOOKAHEAD_MS of half-width, a constant latency on or off.
 *
 * Detection is linked across channels (one reading per sample, from the mean
 * energy), so a stereo image does not wander.
 *
 * BIT-TRANSPARENT WHERE IT IS NOT CUTTING: each stage writes x itself while its
 * gain is exactly 1, and the smoothers snap their tails onto exactly 1. Its
 * filters always run, so they are warm when a cut arrives.
 *
 * This file is BOTH a normal ES module and an AudioWorklet module (registers
 * 'plosive-processor'); it imports from ./dsp/, so its loader goes through
 * `?worker&url` like the others.
 */

import { highpass, lowpass, butterworthQs, DENORMAL_FLOOR } from './dsp/biquad.js'
import { riseCoeff } from './dsp/envelope.js'
import { RunningMin, Boxcar } from './dsp/lookaheadLimiter.js'
import { toKernelParams, PLOSIVE_DEFAULTS, PLOSIVE_LOOKAHEAD_MS } from './plosiveParams.js'

export const PLOSIVE_KERNEL_DEFAULTS = toKernelParams(PLOSIVE_DEFAULTS)

/** Internal constants, fixed at build time. */
export const PLOSIVE_TUNING = {
  // ── POP ──
  // The voice band starts this far above the corner (4th-order high-pass) and
  // stops at popVoiceTopHz (2nd-order low-pass): F0's upper reach, F1 and the
  // harmonics a vowel carries its energy in.
  popVoiceRatio: 2,
  popVoiceTopHz: 3000,
  // Energy followers on both bands. 2 ms is under a third of a cycle at 120 Hz,
  // so the low band's reading ripples; the jump and the ratio are measured in
  // tens of dB and the smoother takes the ripple out of the gain.
  popAttackMs: 2,
  popDetReleaseMs: 20,
  popRiseMs: 20,
  popRiseWindowMs: 15,
  popHysteresisDb: 3,
  popMaxMs: 250,
  // No new pop opens within this of the last one opening. A thump's low band
  // ripples at its own frequency, and at high Sensitivity (a 5 dB jump) a
  // ripple could close a pop and reopen it: one thump counted twice.
  popRefractoryMs: 80,
  // The low band must be within this of the file's voice level to count, with
  // a soft knee: room rumble in a gap jumps too, and stands over a silent
  // voice band by any margin.
  popGateDb: -40,
  popGateKneeDb: 6,
  // ── BURST (from the De-Esser's tuning, unchanged) ──
  burstClosureDb: 15,
  burstClosureMinMs: 15,
  burstClosureMaxMs: 200,
  burstOnsetWindowMs: 10,
  burstRiseMs: 5,
  burstFadeMs: 10,
  burstVoiceGate: true,
  burstReleaseMs: 10,
  detHpHz: 4000,
  detQ: 0.7,
  hfAttackMs: 2,
  hfReleaseMs: 40,
  lmLowHz: 200,
  lmHighHz: 3000,
  lmQ: 0.7,
  voiceAttackMs: 15,
  voiceHoldMs: 500,
  voicedAttackMs: 3,
  voicedDecayMs: 5,
  voiceLedLoDb: 4,
  voiceLedHiDb: 10,
  meterHz: 30,
}

const LN10_OVER_20 = Math.LN10 / 20
const dbToLin = db => Math.exp(db * LN10_OVER_20)
const FOLLOWER_FLOOR = 1e-30
/** Gains within this of 1 are 1: a boxcar's running sum leaves rounding residue. */
const UNITY_SNAP = 1e-7
const BUTTER4_Q = butterworthQs(4)

/** One biquad section, direct form II transposed, explicit state. */
class Biquad {
  constructor(c) {
    this.set(c)
    this.z1 = 0
    this.z2 = 0
  }

  set(c) {
    this.b0 = c.b0
    this.b1 = c.b1
    this.b2 = c.b2
    this.a1 = c.a1
    this.a2 = c.a2
  }

  tick(x) {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }

  flushDenormals() {
    if (Math.abs(this.z1) < DENORMAL_FLOOR && Math.abs(this.z2) < DENORMAL_FLOOR) {
      this.z1 = 0
      this.z2 = 0
    }
  }
}

/** Asymmetric one-pole follower — attack above the state, release below. */
class Follower {
  constructor(sampleRate, attackMs, releaseMs) {
    this.attack = riseCoeff(attackMs, sampleRate)
    this.release = riseCoeff(releaseMs, sampleRate)
    this.value = 0
  }

  tick(x) {
    const y = this.value
    let v = y + (x > y ? this.attack : this.release) * (x - y)
    if (v < FOLLOWER_FLOOR) v = 0
    this.value = v
    return v
  }
}

/**
 * Required gain → applied gain: centred running min and triangular smoother
 * (lookaheadLimiter.js), so the gain is ≤ the requirement at every sample, then
 * an upward-only release. Output lags input by 2L.
 */
class LookaheadGain {
  constructor(L, releaseCoeff) {
    this.min = new RunningMin(2 * L + 1)
    this.box1 = new Boxcar(L + 1)
    this.box2 = new Boxcar(L + 1)
    this.release = releaseCoeff
    this.g = 1
  }

  push(req) {
    let s = this.box2.push(this.box1.push(this.min.push(req)))
    if (s > 1 - UNITY_SNAP) s = 1
    let g = this.g
    if (s <= g) g = s
    else {
      g += this.release * (s - g)
      if (g > 1 - UNITY_SNAP) g = 1
    }
    this.g = g
    return g
  }
}

const toDb = e => (e > 0 ? 10 * Math.log10(e) : -300)

export class PlosiveKernel {
  constructor(sampleRate, tuning = PLOSIVE_TUNING) {
    this.sampleRate = sampleRate
    this.tuning = tuning
    const ms = v => Math.max(1, Math.round((v / 1000) * sampleRate))
    this.ms = ms
    const L = Math.max(1, Math.round((PLOSIVE_LOOKAHEAD_MS / 1000) * sampleRate))
    this.latencySamples = 2 * L

    // Detection filters (coefficients shared, state per channel).
    this.hfCoeffs = highpass(sampleRate, tuning.detHpHz, tuning.detQ)
    this.lmCoeffs = [highpass(sampleRate, tuning.lmLowHz, tuning.lmQ), lowpass(sampleRate, tuning.lmHighHz, tuning.lmQ)]
    this.popFreqHz = 0
    this.burstFreqHz = 0
    this.channels = []

    // POP
    this.lowEnv = new Follower(sampleRate, tuning.popAttackMs, tuning.popDetReleaseMs)
    this.popVoiceEnv = new Follower(sampleRate, tuning.popAttackMs, tuning.popDetReleaseMs)
    this.lowHist = new Float64Array(ms(tuning.popRiseMs)).fill(-300)
    this.lowHistPos = 0
    this.sinceRise = Infinity
    this.popOpen = false
    this.popAge = 0
    this.sincePop = Infinity
    this.popRefractory = ms(tuning.popRefractoryMs)
    this.popRiseWindow = ms(tuning.popRiseWindowMs)
    this.popMax = ms(tuning.popMaxMs)

    // BURST
    this.hfEnv = new Follower(sampleRate, tuning.hfAttackMs, tuning.hfReleaseMs)
    this.hfFast = new Follower(sampleRate, 1, 5)
    this.fullEnv = new Follower(sampleRate, 1, 5)
    this.voiceEnv = new Follower(sampleRate, tuning.voicedAttackMs, tuning.voicedDecayMs)
    this.voiceLevel = new Follower(sampleRate, tuning.voiceAttackMs, tuning.voiceHoldMs)
    this.burstClosureMin = ms(tuning.burstClosureMinMs)
    this.burstClosureMax = ms(tuning.burstClosureMaxMs)
    this.burstOnsetWindow = ms(tuning.burstOnsetWindowMs)
    this.burstFade = ms(tuning.burstFadeMs)
    this.hfHist = new Float64Array(ms(tuning.burstRiseMs)).fill(-300)
    this.hfHistPos = 0
    this.closureRun = 0
    this.sinceClosure = Infinity
    this.burstLeft = 0

    // Gain paths.
    this.popGain = new LookaheadGain(L, riseCoeff(PLOSIVE_DEFAULTS.popRelease, sampleRate))
    this.burstGain = new LookaheadGain(L, riseCoeff(tuning.burstReleaseMs, sampleRate))

    // Meters, since the last takeMeters(): deepest cuts (dB), events opened.
    this.meterPop = 0
    this.meterBurst = 0
    this.pops = 0
    this.bursts = 0
    // Activity scope, one point per process() call: the (delayed) input peak,
    // the output peak before the trim, and whether a burst was being cut —
    // the De-Esser scope's ring format (deEsserScope.js), its guard slot 0.
    this.scopeIn = 0
    this.scopeOut = 0
    this.scopeBurst = 0
    this.meterPeriod = Math.max(1, Math.round(sampleRate / tuning.meterHz))
    this.meterCount = 0

    this.listen = 'off'
    this.params = { ...PLOSIVE_KERNEL_DEFAULTS }
    this.setParams({})
  }

  setParams(partial) {
    const p = { ...this.params, ...partial }
    this.params = p
    const sr = this.sampleRate
    const t = this.tuning
    if (p.popFreqHz !== this.popFreqHz) {
      this.popFreqHz = p.popFreqHz
      this.lowCoeffs = BUTTER4_Q.map(q => lowpass(sr, p.popFreqHz, q))
      const lo = Math.min(p.popFreqHz * t.popVoiceRatio, 0.45 * sr)
      this.popVoiceCoeffs = [...BUTTER4_Q.map(q => highpass(sr, lo, q)), lowpass(sr, t.popVoiceTopHz, Math.SQRT1_2)]
      this.popCutCoeffs = highpass(sr, p.popFreqHz, Math.SQRT1_2)
      for (const c of this.channels) {
        c.low.forEach((b, k) => b.set(this.lowCoeffs[k]))
        c.popVoice.forEach((b, k) => b.set(this.popVoiceCoeffs[k]))
        c.popCut.set(this.popCutCoeffs)
      }
    }
    if (p.burstFreqHz !== this.burstFreqHz) {
      this.burstFreqHz = p.burstFreqHz
      this.burstCutCoeffs = lowpass(sr, Math.min(p.burstFreqHz, 0.45 * sr), Math.SQRT1_2)
      for (const c of this.channels) c.burstCut.set(this.burstCutCoeffs)
    }
    this.popGain.release = riseCoeff(p.popReleaseMs, sr)
    this.popOn = p.popDepthDb > 0
    this.burstOn = p.burstDepthDb > 0
    this.burstLength = this.ms(p.burstLengthMs)
    this.outputLin = dbToLin(p.outputGainDb)
  }

  /** 'off' | 'delta' — delta is what was removed, for monitoring only. */
  setListen(mode) {
    this.listen = mode === 'delta' ? 'delta' : 'off'
  }

  ensureChannels(n) {
    while (this.channels.length < n) {
      this.channels.push({
        hf: new Biquad(this.hfCoeffs),
        lm: this.lmCoeffs.map(c => new Biquad(c)),
        low: this.lowCoeffs.map(c => new Biquad(c)),
        popVoice: this.popVoiceCoeffs.map(c => new Biquad(c)),
        popCut: new Biquad(this.popCutCoeffs),
        burstCut: new Biquad(this.burstCutCoeffs),
        delay: new Float64Array(this.latencySamples),
        pos: 0,
      })
    }
  }

  /**
   * One sample of detection. Returns nothing; leaves the two required gains in
   * `reqPop` / `reqBurst`.
   */
  _detect(lowE, popVoiceE, hfPeak, hfE, lmE, fullE) {
    const t = this.tuning
    const p = this.params

    // ── POP ──
    const lowDb = toDb(this.lowEnv.tick(lowE))
    const pvDb = toDb(this.popVoiceEnv.tick(popVoiceE))
    const hist = this.lowHist
    const rise = lowDb - hist[this.lowHistPos]
    hist[this.lowHistPos] = lowDb
    this.lowHistPos = this.lowHistPos + 1 === hist.length ? 0 : this.lowHistPos + 1
    if (rise >= p.popRiseDb) this.sinceRise = 0
    else this.sinceRise++
    const excess = lowDb - pvDb - p.popRatioDb
    const gateOver = lowDb - (p.voiceLevelDb + t.popGateDb)
    const gate = gateOver <= 0 ? 0 : gateOver >= t.popGateKneeDb ? 1 : gateOver / t.popGateKneeDb
    this.sincePop++
    if (this.popOpen) {
      if (excess < -t.popHysteresisDb || ++this.popAge > this.popMax || gate === 0) this.popOpen = false
    } else if (this.popOn && excess > 0 && gate > 0 && this.sinceRise <= this.popRiseWindow && this.sincePop > this.popRefractory) {
      this.popOpen = true
      this.popAge = 0
      this.sincePop = 0
      this.sinceRise = Infinity
      this.pops++
    }
    let popCut = 0
    if (this.popOpen && excess > 0) popCut = gate * (excess < p.popDepthDb ? excess : p.popDepthDb)
    this.reqPop = popCut > 0 ? dbToLin(-popCut) : 1

    // ── BURST: closure, then a sharp top-band onset ──
    const hf = this.hfEnv.tick(hfPeak)
    const hfDb = hf > 0 ? 20 * Math.log10(hf) : -300
    const voice = this.voiceEnv.tick(lmE)
    const hfFastE = this.hfFast.tick(hfE)
    let wl = 0
    if (voice > 0) {
      const ledDb = hfFastE > 0 ? 10 * Math.log10(voice / hfFastE) : 300
      wl = ledDb <= t.voiceLedLoDb ? 0 : ledDb >= t.voiceLedHiDb ? 1 : (ledDb - t.voiceLedLoDb) / (t.voiceLedHiDb - t.voiceLedLoDb)
    }
    const heldDb = toDb(this.voiceLevel.tick(lmE))
    const fullDb = toDb(this.fullEnv.tick(fullE))
    if (heldDb > -200 && fullDb < heldDb - t.burstClosureDb) {
      this.closureRun++
    } else {
      if (this.closureRun > 0) {
        const run = this.closureRun
        this.sinceClosure = run >= this.burstClosureMin && run <= this.burstClosureMax ? 0 : Infinity
        this.closureRun = 0
      }
      this.sinceClosure++
    }
    const hh = this.hfHist
    const hfRise = hfDb - hh[this.hfHistPos]
    hh[this.hfHistPos] = hfDb
    this.hfHistPos = this.hfHistPos + 1 === hh.length ? 0 : this.hfHistPos + 1
    if (this.burstOn && this.burstLeft <= 0 && this.sinceClosure <= this.burstOnsetWindow && hfRise >= p.burstRiseDb) {
      this.burstLeft = this.burstLength
      this.sinceClosure = Infinity
      this.bursts++
    }
    let wb = 0
    if (this.burstLeft > 0) {
      // ⚠ NOT CUT SHORT BY VOICING (the De-Esser's finding): a broadband T
      // reads as voiced, and a cutoff there closed the window ~10 ms in, before
      // the burst's top-band peak. Closed where the voice LEADS instead.
      wb = this.burstLeft >= this.burstFade ? 1 : this.burstLeft / this.burstFade
      if (t.burstVoiceGate) wb *= 1 - wl
      this.burstLeft--
    }
    this.reqBurst = this.burstOn && wb > 0 ? dbToLin(-wb * p.burstDepthDb) : 1
  }

  /**
   * @param {Float32Array[]} inputChannels
   * @param {Float32Array[]} outputChannels
   * @param {number} n
   */
  process(inputChannels, outputChannels, n) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }
    this.ensureChannels(nOut)
    const chans = this.channels
    const delta = this.listen === 'delta'
    const g = this.outputLin
    const inv = 1 / nOut
    let scIn = 0
    let scOut = 0
    let scBurst = 0
    let minPop = 1
    let minBurst = 1

    for (let i = 0; i < n; i++) {
      let lowE = 0
      let pvE = 0
      let hfPeak = 0
      let hfE = 0
      let lmE = 0
      let fullE = 0
      for (let ch = 0; ch < nOut; ch++) {
        const s = chans[ch]
        const x = inputChannels[ch < nIn ? ch : nIn - 1][i]
        let lo = x
        for (let k = 0; k < s.low.length; k++) lo = s.low[k].tick(lo)
        let pv = x
        for (let k = 0; k < s.popVoice.length; k++) pv = s.popVoice[k].tick(pv)
        const h = s.hf.tick(x)
        const lm = s.lm[1].tick(s.lm[0].tick(x))
        lowE += lo * lo
        pvE += pv * pv
        const a = h < 0 ? -h : h
        if (a > hfPeak) hfPeak = a
        hfE += h * h
        lmE += lm * lm
        fullE += x * x
      }
      this._detect(lowE * inv, pvE * inv, hfPeak, hfE * inv, lmE * inv, fullE * inv)
      const gp = this.popGain.push(this.reqPop)
      const gb = this.burstGain.push(this.reqBurst)
      if (gp < minPop) minPop = gp
      if (gb < minBurst) minBurst = gb
      if (gb < 0.944 && scBurst < 1) scBurst = 1 // ≥ 0.5 dB

      for (let ch = 0; ch < nOut; ch++) {
        const s = chans[ch]
        const x = inputChannels[ch < nIn ? ch : nIn - 1][i]
        const dry = s.delay[s.pos]
        s.delay[s.pos] = x
        s.pos = s.pos + 1 === s.delay.length ? 0 : s.pos + 1
        // Filters always run, so a cut arriving finds them warm.
        const hp = s.popCut.tick(dry)
        let y = gp === 1 ? dry : gp * dry + (1 - gp) * hp
        const lp = s.burstCut.tick(y)
        y = gb === 1 ? y : gb * y + (1 - gb) * lp
        const ad = dry < 0 ? -dry : dry
        if (ad > scIn) scIn = ad
        const ay = y < 0 ? -y : y
        if (ay > scOut) scOut = ay
        outputChannels[ch][i] = delta ? dry - y : g === 1 ? y : y * g
      }
    }

    for (const s of chans) {
      s.hf.flushDenormals()
      for (const b of s.lm) b.flushDenormals()
      for (const b of s.low) b.flushDenormals()
      for (const b of s.popVoice) b.flushDenormals()
      s.popCut.flushDenormals()
      s.burstCut.flushDenormals()
    }

    const cutDb = gmin => (gmin < 1 ? -20 * Math.log10(Math.max(gmin, 1e-6)) : 0)
    const pc = cutDb(minPop)
    const bc = cutDb(minBurst)
    if (pc > this.meterPop) this.meterPop = pc
    if (bc > this.meterBurst) this.meterBurst = bc
    this.scopeIn = scIn
    this.scopeOut = scOut
    this.scopeBurst = scBurst
    this.meterCount += n
  }

  /**
   * Meter readings once a meter period has passed, else null: the deepest POP
   * and BURST cuts since the last reading (dB, positive) and the running event
   * counts.
   */
  takeMeters(force = false) {
    if (!force && this.meterCount < this.meterPeriod) return null
    this.meterCount = 0
    const m = { popDb: this.meterPop, burstDb: this.meterBurst, pops: this.pops, bursts: this.bursts }
    this.meterPop = 0
    this.meterBurst = 0
    return m
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by tests and scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share one code path. The output is
 * delayed by the kernel's latency, like the worklet's. The kernel comes back
 * too, for its event counts.
 */
export function processPlosiveBuffer(channelData, sampleRate, kernelParams = {}, { listen = 'off', tuning } = {}) {
  const kernel = new PlosiveKernel(sampleRate, tuning)
  kernel.setParams(kernelParams)
  kernel.setListen(listen)
  const n = channelData[0].length
  const output = channelData.map(() => new Float32Array(n))
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      output.map(c => c.subarray(off, off + len)),
      len,
    )
  }
  return { channelData: output, latencySamples: kernel.latencySamples, kernel }
}

/** Activity-scope points per meter message, SCOPE_STRIDE (4) floats each. */
export const PLOSIVE_SCOPE_STRIDE = 4
export const PLOSIVE_SCOPE_BATCH_MAX = 64

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class PlosiveWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new PlosiveKernel(sampleRate)
      // Scope points, one per process() call, sent with the meter message — the
      // De-Esser's batching: past the cap, the last slot folds by max.
      this.scope = new Float32Array(PLOSIVE_SCOPE_BATCH_MAX * PLOSIVE_SCOPE_STRIDE)
      this.scopeCount = 0
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params)
      }
      this.port.onmessage = (e) => {
        if (e.data?.type === 'params') this.kernel.setParams(e.data.params)
        else if (e.data?.type === 'listen') this.kernel.setListen(e.data.mode)
      }
    }

    process(inputs, outputs) {
      const input = inputs[0]
      const output = outputs[0]
      if (!output || output.length === 0) return true
      const n = output[0].length
      if (!input || input.length === 0) {
        for (const ch of output) ch.fill(0)
        return true
      }
      const k = this.kernel
      k.process(input, output, n)
      const sc = this.scope
      if (this.scopeCount < PLOSIVE_SCOPE_BATCH_MAX) {
        const o = this.scopeCount * PLOSIVE_SCOPE_STRIDE
        sc[o] = k.scopeIn
        sc[o + 1] = k.scopeOut
        sc[o + 2] = 0
        sc[o + 3] = k.scopeBurst
        this.scopeCount++
      } else {
        const o = (PLOSIVE_SCOPE_BATCH_MAX - 1) * PLOSIVE_SCOPE_STRIDE
        sc[o] = Math.max(sc[o], k.scopeIn)
        sc[o + 1] = Math.max(sc[o + 1], k.scopeOut)
        sc[o + 3] = Math.max(sc[o + 3], k.scopeBurst)
      }
      const m = k.takeMeters()
      if (m) {
        this.port.postMessage({ type: 'meters', ...m, scope: sc.subarray(0, this.scopeCount * PLOSIVE_SCOPE_STRIDE) })
        this.scopeCount = 0
      }
      return true
    }
  }

  registerProcessor('plosive-processor', PlosiveWorkletProcessor)
}
