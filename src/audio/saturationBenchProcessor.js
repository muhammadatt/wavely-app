/**
 * Saturation Bench — layered waveshaping, for auditioning and stacking.
 *
 * Up to four LAYERS in series. Each layer saturates one frequency band of what
 * reaches it and ADDS what the curve created back onto the untouched signal:
 *
 *   src   = band(x)                     4th-order Butterworth HP at `loHz`,
 *                                       LP at `hiHz`; an open edge is flat
 *   added = band( de( f(g·pre(src)) / g ) − src )    4× oversampled
 *   y     = x + α · added               α = voicing weight (VOICED) or 1
 *
 * With the band open at both ends this is exactly a full-band shaper,
 * y = f(g·x)/g blended by α. With it high-passed at 3 kHz it is an exciter.
 * The second band pass on `added` is not optional: an even curve fed a band
 * makes DIFFERENCE tones below it (the envelope traced out as a low buzz), and
 * odd curves make harmonics above a low-passed band; neither belongs to the
 * layer's band.
 *
 * Every curve has f'(0) = 1 and runs as f(g·x)/g, so a quiet signal passes at
 * unity: the curves differ only in what they do to the loud part.
 *
 * DRIVE IS dB ABOVE A MATCHED POINT, NOT A PRE-GAIN. 0 dB puts every curve at
 * `SHAPER_REF_THD` (1 %) on a sine peaking at the layer's REFERENCE PEAK — the
 * file's gated level in that band plus a nominal speech crest, measured by the
 * caller (`refPeakDb`). So a knob position means the same amount of the same
 * kind of distortion on any curve, any band and any recording level, and
 * switching curves compares character rather than strength.
 *
 * ⚠ ON A HIGH BAND, 0 dB IS BARELY AUDIBLE, and that is the calibration being
 * honest rather than wrong: the HF Softener's exciter, where this was built,
 * measured 1 % THD at the band's real peak as "excites nothing" (Tanh at 100 %
 * added +0.6 dB above 5 kHz) and had to sit ~16 dB hotter to brighten vowels
 * about as much as Air +2 dB. An exciter wants +12 to +24 dB here — and on a
 * high band EMPHASIS acts mostly as a drive offset: REV (highs out before the
 * curve) needs ~8–10 dB more than OFF for the same brightening, OPTO ~10 less.
 *
 * EMPHASIS wraps the curve in OptoSmooth's pre/de-emphasis pair (2300 Hz,
 * Q 1/√2, ±10.2 dB). The pair are exact inverses, so the linear path is
 * untouched — only what the curve does differs. ⚠ On a voice the AFTER-shelf
 * decides, not the before-shelf: a vowel's distortion comes from its strong
 * low content and lands above the corner, so OPTO puts 3–4 dB LESS distortion
 * above 2.3 kHz than OFF and REV 3–5 dB MORE. REV is only cleaner up top on
 * content that was already high.
 *
 * VOICED: the layer's contribution follows a voicing weight — low/mid energy
 * against the 4 kHz peak envelope, the HF Softener's vowel-release detector —
 * so sibilants and gaps are never shaped. The detector reads the plugin's
 * INPUT once; each layer reads it delayed by its own position in the chain.
 *
 * LATENCY IS CONSTANT: 50 samples per layer SLOT, whether the slot is on or
 * not, so switching a layer never moves the audio in time. 200 samples, 4.5 ms
 * at 44.1 kHz; the apply path trims it.
 *
 * Pure kernel, importable under node; registers its worklet only in worklet
 * scope.
 */

import { BiquadCascade, highpass, lowpass, highShelf, DENORMAL_FLOOR } from './dsp/biquad.js'
import { Oversampler, DelayLine, COMPRESSOR_OVERSAMPLE } from './dsp/oversample.js'
import { riseCoeff } from './dsp/envelope.js'
import { shaperCurve, unitDriveU, SHAPER_CURVE_IDS } from './dsp/shaperCurves.js'

export const SAT_BENCH_MAX_LAYERS = 4
/** One oversampler's latency, whole base-rate samples. */
export const SAT_BENCH_LAYER_LATENCY = COMPRESSOR_OVERSAMPLE.latencySamples
export const SAT_BENCH_LATENCY_SAMPLES = SAT_BENCH_MAX_LAYERS * SAT_BENCH_LAYER_LATENCY
/** Enough for the voicing detector and band filters to settle. */
export const SAT_BENCH_PREROLL_S = 0.5

export const SAT_EMPH_MODES = ['reverse', 'off', 'opto']
/**
 * OptoSmooth's emphasis pair as it ships: EMPHASIS_CORNER_HZ (2300) and
 * EMPHASIS_MAX_DB (12) × EMPHASIS_DEFAULT (85) / 100. ⚠ COPIED, NOT IMPORTED:
 * la2aProcessor.js registers a worklet at module scope. A test pins the copy.
 */
export const SAT_EMPH_CORNER_HZ = 2300
export const SAT_EMPH_DB = 12 * 0.85
export const SAT_MODES = ['voiced', 'full']

/** Band edges. At or beyond these an edge is open — no filter at all. */
export const SAT_BAND_MIN_HZ = 20
export const SAT_BAND_MAX_HZ = 20000
/** The band never closes tighter than this ratio (a third of an octave). */
export const SAT_BAND_MIN_RATIO = Math.pow(2, 1 / 3)

export const SAT_DRIVE_MIN_DB = -12
export const SAT_DRIVE_MAX_DB = 60

/** Nominal speech crest: a band's reference peak is its gated level + this. */
export const SAT_REF_CREST_DB = 12
/**
 * Reference peak used when the caller has not measured one: a full-band file
 * at the nominal −20 dBFS RMS every other level here is aligned to, plus crest.
 */
export const SAT_DEFAULT_REF_PEAK_DB = -20 + SAT_REF_CREST_DB

export const SAT_LAYER_DEFAULTS = {
  on: false,
  curve: 'quartic',
  driveDb: 0,
  emph: 'off',
  loHz: SAT_BAND_MIN_HZ,
  hiHz: SAT_BAND_MAX_HZ,
  mode: 'voiced',
  refPeakDb: SAT_DEFAULT_REF_PEAK_DB,
}

export const SAT_BENCH_KERNEL_DEFAULTS = {
  // File property: gated RMS minus the nominal −20 dBFS. Moves the voicing
  // detector's floor with the recording level.
  levelOffsetDb: 0,
  layers: Array.from({ length: SAT_BENCH_MAX_LAYERS }, () => ({ ...SAT_LAYER_DEFAULTS })),
}

/** The voicing detector, as the HF Softener tunes it. */
export const SAT_VOICING_TUNING = {
  lmLowHz: 200,
  lmHighHz: 3000,
  lmQ: 0.7,
  detHpHz: 4000,
  detHpQ: 0.7,
  hfAttackMs: 2,
  hfReleaseMs: 40,
  hfVowelReleaseMs: 10,
  voicedAttackMs: 3,
  voicedDecayMs: 5,
  voicedFloorDb: -40,
  voicedMarginDb: 0,
  xfadeDb: 3,
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const IDENTITY = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }
const FOLLOWER_FLOOR = 1e-12

/** A layer's band edges after clamping: open edges come back null. */
export function layerBand(loHz, hiHz, sampleRate) {
  const top = Math.min(SAT_BAND_MAX_HZ, 0.45 * sampleRate)
  let lo = clamp(Number(loHz) || SAT_BAND_MIN_HZ, SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ)
  let hi = clamp(Number(hiHz) || SAT_BAND_MAX_HZ, SAT_BAND_MIN_HZ, SAT_BAND_MAX_HZ)
  if (hi < lo * SAT_BAND_MIN_RATIO) hi = Math.min(SAT_BAND_MAX_HZ, lo * SAT_BAND_MIN_RATIO)
  return { lo: lo > SAT_BAND_MIN_HZ ? lo : null, hi: hi < top ? hi : null }
}

/** Four sections: HP·HP (or identity) then LP·LP (or identity). */
export function layerBandSections(loHz, hiHz, sampleRate) {
  const { lo, hi } = layerBand(loHz, hiHz, sampleRate)
  const hp = lo ? highpass(sampleRate, lo, Math.SQRT1_2) : IDENTITY
  const lp = hi ? lowpass(sampleRate, hi, Math.SQRT1_2) : IDENTITY
  return [hp, hp, lp, lp]
}

/** Pre-gain into the curve for a layer: 0 dB drive = matched THD at the reference peak. */
export function layerGain(curveId, driveDb, refPeakDb) {
  const d = clamp(Number(driveDb) || 0, SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB)
  const ref = Number.isFinite(refPeakDb) ? refPeakDb : SAT_DEFAULT_REF_PEAK_DB
  return (unitDriveU(curveId) / Math.pow(10, ref / 20)) * Math.pow(10, d / 20)
}

/** Normalise one layer's params. */
export function normalizeLayer(p = {}) {
  const l = { ...SAT_LAYER_DEFAULTS, ...p }
  return {
    on: !!l.on,
    curve: SHAPER_CURVE_IDS.includes(l.curve) ? l.curve : SAT_LAYER_DEFAULTS.curve,
    driveDb: clamp(Number(l.driveDb) || 0, SAT_DRIVE_MIN_DB, SAT_DRIVE_MAX_DB),
    emph: SAT_EMPH_MODES.includes(l.emph) ? l.emph : 'off',
    loHz: Number(l.loHz) || SAT_BAND_MIN_HZ,
    hiHz: Number(l.hiHz) || SAT_BAND_MAX_HZ,
    mode: SAT_MODES.includes(l.mode) ? l.mode : 'voiced',
    refPeakDb: Number.isFinite(l.refPeakDb) ? l.refPeakDb : SAT_DEFAULT_REF_PEAK_DB,
  }
}

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

/** Linear ramp toward a target over a fixed number of samples. */
class Ramp {
  constructor(value, samples) {
    this.value = value
    this.target = value
    this.step = 0
    this.remaining = 0
    this.samples = Math.max(1, Math.round(samples))
  }

  set(target, immediate) {
    this.target = target
    if (immediate) {
      this.value = target
      this.remaining = 0
      return
    }
    this.remaining = this.samples
    this.step = (target - this.value) / this.samples
  }

  tick() {
    if (this.remaining > 0) {
      this.value += this.step
      if (--this.remaining === 0) this.value = this.target
    }
    return this.value
  }
}

/**
 * Voicing weight per sample, 0–1, from the plugin's input. The HF Softener's
 * detector without its rotator: low/mid energy (200 Hz–3 kHz) followed at
 * 3/5 ms against a 4 kHz peak envelope that releases fast while voiced, soft
 * crossover over ±3 dB.
 */
export class VoicingDetector {
  constructor(sampleRate, tuning = SAT_VOICING_TUNING) {
    this.sampleRate = sampleRate
    this.tuning = tuning
    this.lmSections = [highpass(sampleRate, tuning.lmLowHz, tuning.lmQ), lowpass(sampleRate, tuning.lmHighHz, tuning.lmQ)]
    this.detSections = [highpass(sampleRate, tuning.detHpHz, tuning.detHpQ)]
    this.lm = null
    this.det = null
    this.channels = 0
    this.voiceEnv = new Follower(sampleRate, tuning.voicedAttackMs, tuning.voicedDecayMs)
    this.hfEnv = new Follower(sampleRate, tuning.hfAttackMs, tuning.hfReleaseMs)
    this.relSlow = this.hfEnv.release
    this.relVowel = riseCoeff(tuning.hfVowelReleaseMs, sampleRate)
    this.levelOffsetDb = 0
    this.lmBuf = []
    this.detBuf = []
  }

  ensure(channels, n) {
    if (channels !== this.channels) {
      this.lm = new BiquadCascade(2, channels)
      this.lm.setSections(this.lmSections)
      this.det = new BiquadCascade(1, channels)
      this.det.setSections(this.detSections)
      this.channels = channels
    }
    while (this.lmBuf.length < channels) {
      this.lmBuf.push(new Float64Array(n))
      this.detBuf.push(new Float64Array(n))
    }
    for (let ch = 0; ch < channels; ch++) {
      if (this.lmBuf[ch].length < n) {
        this.lmBuf[ch] = new Float64Array(n)
        this.detBuf[ch] = new Float64Array(n)
      }
    }
  }

  /** Fill `out` with the weight for each of `n` samples. */
  process(inputs, n, out) {
    const nCh = inputs.length
    this.ensure(nCh, n)
    for (let ch = 0; ch < nCh; ch++) {
      this.lm.process(inputs[ch], this.lmBuf[ch], n, ch)
      this.det.process(inputs[ch], this.detBuf[ch], n, ch)
    }
    const t = this.tuning
    const floor = t.voicedFloorDb + this.levelOffsetDb
    const x = t.xfadeDb
    for (let i = 0; i < n; i++) {
      let energy = 0
      let peak = 0
      for (let ch = 0; ch < nCh; ch++) {
        const lm = this.lmBuf[ch][i]
        energy += lm * lm
        const d = this.detBuf[ch][i]
        const a = d < 0 ? -d : d
        if (a > peak) peak = a
      }
      const voice = this.voiceEnv.tick(energy / nCh)
      const voiceDb = voice > 0 ? 10 * Math.log10(voice) : -300
      const hfPrev = this.hfEnv.value
      const hfDb = hfPrev > 0 ? 20 * Math.log10(hfPrev) : -300
      const over = Math.min(voiceDb - floor, voiceDb - hfDb - t.voicedMarginDb)
      const wv = over <= -x ? 0 : over >= x ? 1 : (over + x) / (2 * x)
      this.hfEnv.release = this.relSlow + wv * (this.relVowel - this.relSlow)
      this.hfEnv.tick(peak)
      out[i] = wv
    }
  }
}

/** One layer's per-channel state. */
function makeLayerChannel() {
  return {
    os: new Oversampler(COMPRESSOR_OVERSAMPLE),
    bandIn: new BiquadCascade(4, 1),
    bandOut: new BiquadCascade(4, 1),
    pre: new BiquadCascade(1, 1),
    de: new BiquadCascade(1, 1),
    srcDelay: new DelayLine(SAT_BENCH_LAYER_LATENCY),
    dryDelay: new DelayLine(SAT_BENCH_LAYER_LATENCY),
    dcX: 0,
    dcY: 0,
  }
}

class Layer {
  constructor(sampleRate, rampSamples) {
    this.sampleRate = sampleRate
    this.p = normalizeLayer()
    this.fn = shaperCurve(this.p.curve).f
    this.gain = 1
    this.full = new Ramp(0, rampSamples)
    this.bandSections = layerBandSections(this.p.loHz, this.p.hiHz, sampleRate)
    this.hasBand = false
    this.emphPre = null
    this.emphDe = null
    this.channels = []
    this.dcCoeff = Math.exp((-2 * Math.PI * 5) / sampleRate)
  }

  set(p, immediate) {
    const prev = this.p
    const next = normalizeLayer(p)
    this.p = next
    this.fn = shaperCurve(next.curve).f
    this.gain = layerGain(next.curve, next.driveDb, next.refPeakDb)
    this.full.set(next.mode === 'full' ? 1 : 0, immediate)
    if (next.loHz !== prev.loHz || next.hiHz !== prev.hiHz || !this.bandInit) {
      this.bandInit = true
      const { lo, hi } = layerBand(next.loHz, next.hiHz, this.sampleRate)
      this.hasBand = !!(lo || hi)
      this.bandSections = layerBandSections(next.loHz, next.hiHz, this.sampleRate)
      for (const c of this.channels) {
        c.bandIn.setSections(this.bandSections)
        c.bandOut.setSections(this.bandSections)
      }
    }
    if (next.emph !== prev.emph || !this.emphInit) {
      this.emphInit = true
      if (next.emph !== 'off') {
        // OPTO boosts into the curve and cuts after; REVERSE is the mirror.
        const db = next.emph === 'opto' ? SAT_EMPH_DB : -SAT_EMPH_DB
        this.emphPre = [highShelf(this.sampleRate, SAT_EMPH_CORNER_HZ, Math.SQRT1_2, db)]
        this.emphDe = [highShelf(this.sampleRate, SAT_EMPH_CORNER_HZ, Math.SQRT1_2, -db)]
        for (const c of this.channels) {
          c.pre.setSections(this.emphPre)
          c.de.setSections(this.emphDe)
        }
      }
    }
    if (next.on && !prev.on) {
      // Engaging: start the oversampler, filters and DC state from rest. The
      // dry delay keeps running either way, so the timing never jumps.
      for (const c of this.channels) this.resetChannel(c)
    }
  }

  resetChannel(c) {
    c.os.reset()
    c.bandIn.setSections(this.bandSections)
    c.bandOut.setSections(this.bandSections)
    c.bandIn.reset?.()
    c.bandOut.reset?.()
    if (this.emphPre) {
      c.pre.setSections(this.emphPre)
      c.de.setSections(this.emphDe)
    }
    c.pre.reset?.()
    c.de.reset?.()
    c.srcDelay.reset()
    c.dcX = 0
    c.dcY = 0
  }

  ensure(nCh, n) {
    while (this.channels.length < nCh) {
      const c = makeLayerChannel()
      this.resetChannel(c)
      this.channels.push(c)
    }
    for (const c of this.channels) {
      if (!c.src || c.src.length < n) {
        c.src = new Float64Array(n)
        c.preBuf = new Float64Array(n)
        c.down = new Float64Array(n)
      }
    }
  }

  /**
   * Process `n` samples of every channel from `xs` into `ys` (may alias).
   * `w` is the voicing weight aligned to this layer's output.
   */
  process(xs, ys, n, w) {
    const nCh = xs.length
    this.ensure(nCh, n)
    if (!this.p.on) {
      for (let ch = 0; ch < nCh; ch++) {
        const c = this.channels[ch]
        const x = xs[ch]
        const y = ys[ch]
        for (let i = 0; i < n; i++) y[i] = c.dryDelay.push(x[i])
      }
      return
    }
    const f = this.fn
    const g = this.gain
    const inv = 1 / g
    const a = this.dcCoeff
    const emph = this.p.emph !== 'off'
    const band = this.hasBand
    // The mode ramp is shared by every channel, so tick it once per sample.
    if (!this.alpha || this.alpha.length < n) this.alpha = new Float64Array(n)
    const alpha = this.alpha
    for (let i = 0; i < n; i++) {
      const full = this.full.tick()
      alpha[i] = w[i] + full * (1 - w[i])
    }
    for (let ch = 0; ch < nCh; ch++) {
      const c = this.channels[ch]
      const x = xs[ch]
      const y = ys[ch]
      let src = x
      if (band) {
        c.bandIn.process(x, c.src, n, 0)
        src = c.src
      }
      // Emphasis at the base rate, as OptoSmooth runs it: both shelves are
      // LTI and commute with the oversampler's delay.
      if (emph) c.pre.process(src, c.preBuf, n, 0)
      const hi = c.os.up(emph ? c.preBuf : src, n)
      const m = n * c.os.factor
      for (let j = 0; j < m; j++) hi[j] = f(g * hi[j]) * inv
      c.os.down(c.down, n)
      if (emph) c.de.process(c.down, c.down, n, 0)
      // What the curve added to the band.
      for (let i = 0; i < n; i++) c.down[i] -= c.srcDelay.push(src[i])
      if (band) c.bandOut.process(c.down, c.down, n, 0)
      let dx = c.dcX
      let dy = c.dcY
      for (let i = 0; i < n; i++) {
        const d = c.down[i]
        dy = d - dx + a * dy
        dx = d
        const dry = c.dryDelay.push(x[i])
        y[i] = dry + alpha[i] * dy
      }
      if (Math.abs(dy) < DENORMAL_FLOOR) dy = 0
      c.dcX = dx
      c.dcY = dy
    }
  }
}

export const SAT_LISTEN_MODES = ['off', 'delta']

export class SaturationBenchKernel {
  constructor(sampleRate) {
    this.sampleRate = sampleRate
    const rampSamples = 0.02 * sampleRate
    this.detector = new VoicingDetector(sampleRate)
    this.layers = Array.from({ length: SAT_BENCH_MAX_LAYERS }, () => new Layer(sampleRate, rampSamples))
    // Voicing history, so each layer reads the weight for the input sample its
    // output corresponds to. ⚠ It must hold the deepest lag PLUS a whole block:
    // a block's weights are written before any layer reads, and at LATENCY + 1
    // the write overran entries slot 4 still needed.
    this.wHist = new Float64Array(SAT_BENCH_LATENCY_SAMPLES + 128 + 1)
    this.wPos = 0
    this.wNow = new Float64Array(128)
    this.wLayer = new Float64Array(128)
    this.work = []
    this.dryDelays = []
    this.listen = 'off'
    this.setParams(SAT_BENCH_KERNEL_DEFAULTS, true)
  }

  get latencySamples() {
    return SAT_BENCH_LATENCY_SAMPLES
  }

  setParams(p = {}, immediate = false) {
    if (Number.isFinite(p.levelOffsetDb)) this.detector.levelOffsetDb = clamp(p.levelOffsetDb, -24, 24)
    const layers = Array.isArray(p.layers) ? p.layers : []
    for (let k = 0; k < SAT_BENCH_MAX_LAYERS; k++) {
      if (layers[k]) this.layers[k].set(layers[k], immediate)
    }
  }

  setListen(mode) {
    this.listen = SAT_LISTEN_MODES.includes(mode) ? mode : 'off'
  }

  process(inputs, outputs, n) {
    const nIn = inputs.length
    const nOut = outputs.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputs[ch].fill(0, 0, n)
      return
    }
    const xs = []
    for (let ch = 0; ch < nOut; ch++) xs.push(inputs[ch < nIn ? ch : nIn - 1])
    if (this.wNow.length < n) {
      this.wNow = new Float64Array(n)
      this.wLayer = new Float64Array(n)
    }
    while (this.work.length < nOut) this.work.push(new Float64Array(n))
    while (this.dryDelays.length < nOut) this.dryDelays.push(new DelayLine(SAT_BENCH_LATENCY_SAMPLES))
    for (let ch = 0; ch < nOut; ch++) if (this.work[ch].length < n) this.work[ch] = new Float64Array(n)

    const anyVoiced = this.layers.some(l => l.p.on && (l.p.mode === 'voiced' || l.full.value < 1))
    if (anyVoiced) this.detector.process(xs, n, this.wNow)
    else this.wNow.fill(0, 0, n)

    if (this.wHist.length < SAT_BENCH_LATENCY_SAMPLES + n + 1) {
      // A block larger than the worklet's 128 (offline callers): regrow, keeping
      // the history in order.
      const old = this.wHist
      const grown = new Float64Array(SAT_BENCH_LATENCY_SAMPLES + n + 1)
      for (let j = 0; j < old.length; j++) grown[j] = old[(this.wPos + j) % old.length]
      this.wHist = grown
      this.wPos = old.length
    }
    // Record the weights, then read each layer's lag behind them.
    const H = this.wHist.length
    const base = this.wPos
    for (let i = 0; i < n; i++) this.wHist[(base + i) % H] = this.wNow[i]
    this.wPos = (base + n) % H

    const bufs = this.work.slice(0, nOut)
    for (let ch = 0; ch < nOut; ch++) bufs[ch].set(xs[ch].subarray(0, n))
    for (let k = 0; k < SAT_BENCH_MAX_LAYERS; k++) {
      const lag = (k + 1) * SAT_BENCH_LAYER_LATENCY
      for (let i = 0; i < n; i++) this.wLayer[i] = this.wHist[(((base + i - lag) % H) + H) % H]
      this.layers[k].process(bufs, bufs, n, this.wLayer)
    }
    for (let ch = 0; ch < nOut; ch++) {
      const out = outputs[ch]
      const y = bufs[ch]
      if (this.listen === 'delta') {
        const dd = this.dryDelays[ch]
        const x = xs[ch]
        for (let i = 0; i < n; i++) out[i] = y[i] - dd.push(x[i])
      } else {
        const dd = this.dryDelays[ch]
        const x = xs[ch]
        for (let i = 0; i < n; i++) {
          dd.push(x[i])
          out[i] = y[i]
        }
      }
    }
  }
}

/** Offline render for tests and measurement. */
export function processSaturationBenchBuffer(channelData, sampleRate, params = {}, options = {}) {
  const kernel = new SaturationBenchKernel(sampleRate)
  kernel.setParams(params, true)
  if (options.listen) kernel.setListen(options.listen)
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
  return { channelData: output, latencySamples: kernel.latencySamples }
}

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class SaturationBenchWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new SaturationBenchKernel(sampleRate)
      if (options?.processorOptions?.params) this.kernel.setParams(options.processorOptions.params, true)
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
      this.kernel.process(input, output, n)
      return true
    }
  }

  registerProcessor('saturation-bench-processor', SaturationBenchWorkletProcessor)
}
