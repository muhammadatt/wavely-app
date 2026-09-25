/**
 * Dynamic HF Softener — worklet kernel.
 *
 * Softens sibilance and harshness on close-miked voice without taking average
 * brightness with it. The problem it targets is EPISODIC, not spectral: a
 * well-recorded voice's long-term spectrum is usually fine, and what reads as
 * harsh is individual consonants spiking 10–15 dB over the vowels around them
 * for 20–40 ms. So the audio path holds exactly one element — a high shelf
 * whose gain moves — and everything else is detection:
 *
 *   Module A  phase rotator: three all-passes (3.2 / 5.6 / 9 kHz) on the
 *             DETECTOR branch, lowering the sibilant's crest factor so the
 *             follower tracks HF energy rather than individual peaks.
 *   Module B  dynamic HF shelf: 4 kHz HP detector → peak follower (2 ms
 *             attack, Release outside vowels, 10 ms inside them) → soft-knee
 *             gain computer → 4.5 kHz shelf, 0 to −D_max dB. The 'band' shape
 *             (default) adds an opposite shelf at 11 kHz so the cut returns to
 *             flat and leaves the air above ~14 kHz alone.
 *   Module C  adaptive threshold: a slow 200 Hz–3 kHz RMS follower raises T
 *             when there is vowel energy for a sibilant to hide under. It only
 *             ever RAISES it — letting it drop in quiet passages would engage
 *             on breath, which is the one thing this processor must not do.
 *
 * Specification: "Dynamic HF Softener — Plugin Specification" (Claude doc,
 * 2026-09-25). Every constant in HF_SOFTENER_TUNING is quoted from it.
 *
 * Below threshold the shelf sits at exactly 0 dB, and an RBJ shelf at 0 dB has
 * identical numerator and denominator, so the processor is BIT-transparent
 * there rather than merely near it. That is the mechanism behind "preserve
 * air", and `test/dsp/hfSoftener.test.js` pins it.
 *
 * This file is BOTH a normal ES module and an AudioWorklet module (registers
 * 'hf-softener-processor'). It imports from ./dsp/, which is why its loader
 * pulls it through `?worker&url` — see hfSoftenerWorkletLoader.js.
 *
 * Portability (a Python port is anticipated): time constants live in ms and
 * are converted at the running rate, biquad state is explicit, the gain
 * computer and the threshold law are pure functions, and every default is one
 * plain JSON-serialisable object.
 */

import {
  allpass, highpass, lowpass, highShelf, groupDelaySeconds, magnitudeResponseDb, DENORMAL_FLOOR,
} from './dsp/biquad.js'
import { riseCoeff } from './dsp/envelope.js'

/** Internal constants, fixed at build time. Quoted from the spec's table. */
export const HF_SOFTENER_TUNING = {
  // Module A
  apFreqsHz: [3200, 5600, 9000],
  apQs: [0.7, 0.8, 0.7],
  maxGroupDelayMs: 2.0,
  // Module B
  shelfFreqHz: 4500,
  shelfQ: 0.7,
  detHpFreqHz: 4000,
  detHpQ: 0.7,
  attackMs: 2.0,
  // Band shape: the 4.5 kHz shelf followed by an equal and opposite shelf at
  // 11 kHz, so the cut returns to flat and the air above ~14 kHz is left
  // alone. Q 0.8 is the widest return that barely boosts (≤ 0.16 dB at the
  // 12 dB maximum). The two shelves overlap, so the pair bottoms out short of
  // its nominal gain — by a factor that grows with depth (×1.17 at 1 dB to
  // ×1.30 at 12, at 44.1 kHz) and with sample rate (×1.51 at 12 dB, 96 kHz).
  // No constant covers that; `bandDepthComp` solves it per rate instead, so
  // the band's deepest point is the depth asked for in both shapes.
  returnFreqHz: 11000,
  returnQ: 0.8,
  // Vowel release: while the low/mid band is voiced, the HF follower releases
  // at `vowelReleaseMs` instead of the Release setting. Carryover lands on the
  // vowel after an "s"; the gaps inside a consonant run are unvoiced, so they
  // keep the slow release and do not chatter.
  vowelReleaseMs: 10,
  voicedAttackMs: 3,
  // ⚠ 5 ms, not slower: a lingering voicing flag from the vowel BEFORE an "s"
  // fires the fast release inside the "s" and under-treats it. At 20 ms the
  // in-phrase sibilant lost 0.5 dB of reduction; at 5 ms it loses 0.1.
  voicedDecayMs: 5,
  voicedFloorDb: -40, // L_ref − 20: below this nothing counts as voiced
  voicedMarginDb: 0, // voiced needs low/mid above the HF envelope by this much
  ratio: 3.0,
  kneeDb: 6.0, // ± around the threshold, quadratic
  // Module C
  lmLowHz: 200,
  lmHighHz: 3000,
  lmQ: 0.7,
  lmAttackMs: 15,
  lmReleaseMs: 150,
  lRefDb: -20,
  maxShiftDb: 8.0,
  // Level alignment. Every absolute level in the detector — T_base, L_ref,
  // the voicing floor — is quoted for a file whose gated RMS sits here, and
  // shifts dB-for-dB with the file's measured level. The detector is linear
  // (filters, |x| and x² followers), so this makes the gain curve exactly
  // invariant to how hot the file was recorded. −20 dBFS is the spec's own
  // "typical speaking vowel" (L_ref), so a file there behaves as specified.
  nominalLevelDbfs: -20,
  maxLevelOffsetDb: 24,
  // Implementation
  gainSmoothMs: 0.5,
  macroRampMs: 20,
  coeffUpdateSamples: 16,
  meterHz: 30,
}

/** User-facing parameters. The four controls, minus Listen (a monitor tap). */
export const HF_SOFTENER_KERNEL_DEFAULTS = {
  amount: 0.4, // 0–1
  context: 0.5, // 0–1 → κ 0–0.8
  rotator: 'sidechain', // 'off' | 'sidechain' | 'inpath'
  releaseMs: 60, // HF follower release outside vowels, 20–150
  vowelRelease: true, // let go fast when a vowel starts
  shape: 'band', // 'shelf' (the spec's) | 'band' (returns to flat above 11 kHz)
  // File property, not a patch value: the file's gated RMS minus the nominal
  // level. Measured by the caller over the WHOLE file (see levelOffsetDbFor).
  levelOffsetDb: 0,
}

export const SHAPES = ['shelf', 'band']
export const RELEASE_MS_MIN = 20
export const RELEASE_MS_MAX = 150

export const ROTATOR_MODES = ['off', 'sidechain', 'inpath']
export const LISTEN_MODES = ['off', 'delta', 'sidechain']

/**
 * Detector trim applied while the rotator is in circuit, so switching it does
 * not move the effective threshold.
 *
 * ⚠ IT IS MEASURED ON THE PEAK FOLLOWER'S OUTPUT, NOT ON RMS. The spec says
 * "RMS of rotated versus unrotated detector signal on pink noise", but an
 * all-pass leaves RMS unchanged by construction (it measures 0.00 dB), so an
 * RMS trim is always unity and corrects nothing. What the rotator changes is
 * crest factor, and the quantity that shifts the threshold is the level the
 * PEAK follower reads — so that is what is matched: the mean of the follower's
 * dB reading over pink noise, rotator on vs off. Measured +0.46 / +0.49 /
 * +0.56 dB at 44.1 / 48 / 96 kHz — the rotator makes the follower read HIGHER
 * on noise, not lower. Re-measured by the test suite; update it here if the
 * cascade or ballistics move.
 */
export const ROTATOR_DETECTOR_TRIM_DB = -0.5

const LN10_OVER_20 = Math.LN10 / 20
const DB_PER_NEPER = 20 / Math.LN10
const FOLLOWER_FLOOR = 1e-15

// ── Macros ──────────────────────────────────────────────────────────────────

/*
 * Amount drives T_base and D_max jointly. The spec pins three points: 0 %
 * never engages (0 dBFS), 40 % is the tuned default (−34 dBFS, 6 dB), 100 %
 * is −44 dBFS and 9 dB — the last depth since raised to 12 dB. Threshold and
 * depth rise together at a fixed 3:1, so the HF level that reaches FULL depth
 * barely moves across the knob (−16 dBFS at 40 %, −17 at the spec's 100 %);
 * 9 dB at the top bought only 3 dB over the default on the loudest esses. A power law through them spends most of the knob's
 * travel in the −23 to −44 dBFS region where speech sibilants actually sit,
 * instead of the linear map's first half, which would do nothing audible.
 */
const AMOUNT_REF = 0.4
const T_AT_REF = -34
const T_AT_FULL = -44
const D_AT_REF = 6
const D_AT_FULL = 12 // the spec's 9, raised after listening: 9 ran out on hard esses
const T_EXP = Math.log(T_AT_REF / T_AT_FULL) / Math.log(AMOUNT_REF)
const D_EXP = Math.log(D_AT_REF / D_AT_FULL) / Math.log(AMOUNT_REF)

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/** Amount (0–1) → T_base in dBFS. 0 → 0 dBFS, 0.4 → −34, 1 → −44. */
export function amountToThresholdDb(amount) {
  const a = clamp(amount, 0, 1)
  return a === 0 ? 0 : T_AT_FULL * Math.pow(a, T_EXP)
}

/** Amount (0–1) → D_max in dB. 0 → 0, 0.4 → 6, 1 → 12. */
export function amountToMaxDepthDb(amount) {
  const a = clamp(amount, 0, 1)
  return a === 0 ? 0 : D_AT_FULL * Math.pow(a, D_EXP)
}

/**
 * The file's gated RMS (dBFS) → the offset every detector level shifts by,
 * clamped. Louder file, higher thresholds.
 */
export function levelOffsetDbFor(gatedRmsDbfs, tuning = HF_SOFTENER_TUNING) {
  if (!Number.isFinite(gatedRmsDbfs)) return 0
  return clamp(gatedRmsDbfs - tuning.nominalLevelDbfs, -tuning.maxLevelOffsetDb, tuning.maxLevelOffsetDb)
}

/** Context (0–1) → κ, Module C's modulation depth. 0 = fixed threshold. */
export function contextToKappa(context) {
  return 0.8 * clamp(context, 0, 1)
}

// ── Pure laws ───────────────────────────────────────────────────────────────

/**
 * Module B's gain computer: detector level → shelf gain, dB (≤ 0).
 *
 * `over / ratio`, capped at `maxDepthDb`, with a quadratic knee spanning
 * ±kneeDb around the threshold. The knee is not cosmetic — a hard corner is
 * exactly the threshold cliff (one sibilant clamped, the next passed) this
 * design exists to avoid. Continuous in value and slope at both knee edges.
 */
export function gainComputerDb(levelDb, thresholdDb, ratio, maxDepthDb, kneeDb) {
  const over = levelDb - thresholdDb
  if (over <= -kneeDb) return 0
  let reduction
  if (over < kneeDb) {
    const t = over + kneeDb
    reduction = (t * t) / (4 * kneeDb * ratio)
  } else {
    reduction = over / ratio
  }
  return reduction < maxDepthDb ? -reduction : -maxDepthDb
}

/**
 * Module C's threshold law: T_eff = T_base + clamp(κ·(L_lm − L_ref), 0, M).
 * The lower clamp of 0 is load-bearing — see the header.
 */
export function adaptiveThresholdDb(baseDb, lmDb, kappa, lRefDb, maxShiftDb) {
  const shift = kappa * (lmDb - lRefDb)
  return baseDb + (shift <= 0 ? 0 : shift > maxShiftDb ? maxShiftDb : shift)
}

/** Module A's sections at a sample rate. */
export function rotatorSections(sampleRate, tuning = HF_SOFTENER_TUNING) {
  return tuning.apFreqsHz.map((f, i) => allpass(sampleRate, f, tuning.apQs[i]))
}

/** The audio-path shelf at a gain. */
export function shelfSection(sampleRate, gainDb, tuning = HF_SOFTENER_TUNING) {
  return highShelf(sampleRate, tuning.shelfFreqHz, tuning.shelfQ, gainDb, 'q')
}

const IDENTITY = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 }

function bandPair(sampleRate, g, tuning) {
  return [
    shelfSection(sampleRate, g, tuning),
    highShelf(sampleRate, tuning.returnFreqHz, tuning.returnQ, -g, 'q'),
  ]
}

const COMP_DEPTHS = [1, 3, 6, 9, 12, 15]
const compTables = new Map()

/**
 * The gain multiplier that makes the band's deepest point land exactly on
 * `depthDb`. Solved by bisection once per sample rate at six depths, then
 * interpolated — a few ms at construction, nothing per sample.
 */
export function bandDepthComp(sampleRate, depthDb, tuning = HF_SOFTENER_TUNING) {
  const key = `${sampleRate}:${tuning.shelfFreqHz}:${tuning.shelfQ}:${tuning.returnFreqHz}:${tuning.returnQ}`
  let table = compTables.get(key)
  if (!table) {
    const top = 0.49 * sampleRate
    const grid = Array.from({ length: 240 }, (_, i) => 2000 * Math.pow(top / 2000, i / 239))
    table = COMP_DEPTHS.map(d => {
      let lo = 1, hi = 2.5
      for (let it = 0; it < 30; it++) {
        const c = (lo + hi) / 2
        const deepest = Math.min(...magnitudeResponseDb(bandPair(sampleRate, -d * c, tuning), grid, sampleRate))
        if (deepest > -d) lo = c
        else hi = c
      }
      return (lo + hi) / 2
    })
    compTables.set(key, table)
  }
  const d = Math.abs(depthDb)
  if (d <= COMP_DEPTHS[0]) return table[0]
  for (let i = 1; i < COMP_DEPTHS.length; i++) {
    if (d <= COMP_DEPTHS[i]) {
      const t = (d - COMP_DEPTHS[i - 1]) / (COMP_DEPTHS[i] - COMP_DEPTHS[i - 1])
      return table[i - 1] + t * (table[i] - table[i - 1])
    }
  }
  return table[table.length - 1]
}

/**
 * The audio path's two sections at a gain — shared with the panel's curve
 * display. 'shelf' is the spec's single shelf (second section an exact
 * identity); 'band' adds the return shelf. At 0 dB both are exact identities.
 */
export function softenerSections(sampleRate, gainDb, shape = 'band', tuning = HF_SOFTENER_TUNING) {
  if (shape !== 'band') return [shelfSection(sampleRate, gainDb, tuning), IDENTITY]
  return bandPair(sampleRate, gainDb * bandDepthComp(sampleRate, gainDb, tuning), tuning)
}

/**
 * Worst-case rotator group delay above 3 kHz, in ms. The spec's hard budget
 * is 2 ms — past it percussive content acquires a metallic ring.
 */
export function rotatorMaxGroupDelayMs(sampleRate, tuning = HF_SOFTENER_TUNING) {
  const sections = rotatorSections(sampleRate, tuning)
  const top = Math.min(20000, 0.45 * sampleRate)
  let worst = 0
  for (let i = 0; i <= 96; i++) {
    const f = 3000 * Math.pow(top / 3000, i / 96)
    worst = Math.max(worst, groupDelaySeconds(sections, f, sampleRate) * 1000)
  }
  return worst
}

// ── Small stateful blocks ───────────────────────────────────────────────────

/** One biquad section, direct form II transposed, explicit state. */
export class Biquad {
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

/**
 * Asymmetric one-pole follower. Attack while the input exceeds the state,
 * release otherwise — the spec's peak follower on |x|, and (fed x²) its
 * low/mid RMS follower.
 */
export class Follower {
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

// ── Kernel ──────────────────────────────────────────────────────────────────

export class HFSoftenerKernel {
  constructor(sampleRate, tuning = HF_SOFTENER_TUNING) {
    this.sampleRate = sampleRate
    this.tuning = tuning

    const gd = rotatorMaxGroupDelayMs(sampleRate, tuning)
    if (gd >= tuning.maxGroupDelayMs) {
      throw new Error(`HF softener: rotator group delay ${gd.toFixed(3)} ms exceeds ${tuning.maxGroupDelayMs} ms`)
    }

    this.rotatorCoeffs = rotatorSections(sampleRate, tuning)
    this.detHpCoeffs = highpass(sampleRate, tuning.detHpFreqHz, tuning.detHpQ)
    this.lmHpCoeffs = highpass(sampleRate, tuning.lmLowHz, tuning.lmQ)
    this.lmLpCoeffs = lowpass(sampleRate, tuning.lmHighHz, tuning.lmQ)
    this.channels = []

    // Stereo is linked: one detector reading drives one shelf gain on every
    // channel, so the image does not wander on a sibilant panned off-centre.
    this.hfEnv = new Follower(sampleRate, tuning.attackMs, HF_SOFTENER_KERNEL_DEFAULTS.releaseMs)
    this.relSlow = this.hfEnv.release
    this.relVowel = riseCoeff(tuning.vowelReleaseMs, sampleRate)
    this.voiceEnv = new Follower(sampleRate, tuning.voicedAttackMs, tuning.voicedDecayMs)
    this.lmEnv = new Follower(sampleRate, tuning.lmAttackMs, tuning.lmReleaseMs)
    this.gainSmooth = riseCoeff(tuning.gainSmoothMs, sampleRate)
    this.levelOffsetDb = 0
    this.shelfGainDb = 0

    const rampSamples = (tuning.macroRampMs / 1000) * sampleRate
    this.tBase = new Ramp(0, rampSamples)
    this.dMax = new Ramp(0, rampSamples)
    this.kappa = new Ramp(0, rampSamples)
    // 0 → dry into the detector / audio path, 1 → rotated. Ramped so a mode
    // switch mid-playback crossfades instead of stepping phase (a click).
    this.detRot = new Ramp(0, rampSamples)
    this.pathRot = new Ramp(0, rampSamples)
    this.rotTrim = Math.exp(ROTATOR_DETECTOR_TRIM_DB * LN10_OVER_20)

    // Audio-path coefficients, two sections × 5: `cur` is what the last chunk
    // ended on.
    this.coeffCur = new Float64Array(10)
    this.coeffNext = new Float64Array(10)
    this.shape = 'band'
    this.writeShelf(this.coeffCur, 0)
    const chunk = tuning.coeffUpdateSamples
    this.gainBuf = new Float64Array(chunk)

    this.listen = 'off'
    this.meterPeriod = Math.max(1, Math.round(sampleRate / tuning.meterHz))
    this.meterCount = 0
    this.meterMaxReduction = 0
    this.lastThresholdLiftDb = 0

    this.params = { ...HF_SOFTENER_KERNEL_DEFAULTS }
    this.setParams({}, true)
  }

  /**
   * Merge a partial update. Macro changes ramp over `macroRampMs` so a
   * dragged slider does not click; `immediate` is for construction, where the
   * offline render must start on its settings rather than ramp into them.
   */
  setParams(partial, immediate = false) {
    const p = { ...this.params, ...partial }
    if (!ROTATOR_MODES.includes(p.rotator)) p.rotator = HF_SOFTENER_KERNEL_DEFAULTS.rotator
    if (!SHAPES.includes(p.shape)) p.shape = HF_SOFTENER_KERNEL_DEFAULTS.shape
    this.params = p
    // Release and shape need no ramp: a release change alters a rate, not a
    // level, and a shape change lands through the per-chunk coefficient
    // interpolation like any other gain move.
    this.relSlow = riseCoeff(clamp(p.releaseMs, RELEASE_MS_MIN, RELEASE_MS_MAX), this.sampleRate)
    this.vowelRelease = !!p.vowelRelease
    this.shape = p.shape
    if (immediate) this.writeShelf(this.coeffCur, this.shelfGainDb)
    const off = clamp(Number(p.levelOffsetDb) || 0, -this.tuning.maxLevelOffsetDb, this.tuning.maxLevelOffsetDb)
    this.levelOffsetDb = off
    // 0 % still means "never engages", whatever the file's level.
    this.tBase.set(p.amount > 0 ? amountToThresholdDb(p.amount) + off : 0, immediate)
    this.dMax.set(amountToMaxDepthDb(p.amount), immediate)
    this.kappa.set(contextToKappa(p.context), immediate)
    this.detRot.set(p.rotator === 'off' ? 0 : 1, immediate)
    this.pathRot.set(p.rotator === 'inpath' ? 1 : 0, immediate)
  }

  /** Monitor tap. Deliberately not a param: the apply path must never see it. */
  setListen(mode) {
    this.listen = LISTEN_MODES.includes(mode) ? mode : 'off'
  }

  writeShelf(dst, gainDb) {
    // Snap near-zero gain to exactly zero, where each shelf's numerator and
    // denominator are identical and the filter is an exact identity.
    const secs = softenerSections(this.sampleRate, Math.abs(gainDb) < 1e-4 ? 0 : gainDb, this.shape, this.tuning)
    for (let k = 0; k < 2; k++) {
      const c = secs[k]
      const o = k * 5
      dst[o] = c.b0
      dst[o + 1] = c.b1
      dst[o + 2] = c.b2
      dst[o + 3] = c.a1
      dst[o + 4] = c.a2
    }
  }

  ensureChannels(n) {
    while (this.channels.length < n) {
      this.channels.push({
        rot: this.rotatorCoeffs.map(c => new Biquad(c)),
        detHp: new Biquad(this.detHpCoeffs),
        lmHp: new Biquad(this.lmHpCoeffs),
        lmLp: new Biquad(this.lmLpCoeffs),
        z: new Float64Array(4), // z1, z2 per audio-path section
        work: new Float64Array(this.tuning.coeffUpdateSamples),
        // Per-chunk scratch: shelf input and detector signal.
        pathBuf: new Float64Array(this.tuning.coeffUpdateSamples),
        detBuf: new Float64Array(this.tuning.coeffUpdateSamples),
      })
    }
  }

  /**
   * Process one block.
   *
   * @param {Float32Array[]} inputChannels
   * @param {Float32Array[]} outputChannels
   * @param {number} n
   * @param {Float32Array} [gainOut] optional per-sample shelf gain (dB) sink
   */
  process(inputChannels, outputChannels, n, gainOut) {
    const nIn = inputChannels.length
    const nOut = outputChannels.length
    if (nIn === 0 || n === 0) {
      for (let ch = 0; ch < nOut; ch++) outputChannels[ch].fill(0, 0, n)
      return
    }
    this.ensureChannels(nOut)

    const { tuning } = this
    const chunk = tuning.coeffUpdateSamples
    const chans = this.channels
    const gainBuf = this.gainBuf
    const cur = this.coeffCur
    const next = this.coeffNext

    for (let off = 0; off < n; off += chunk) {
      const len = Math.min(chunk, n - off)

      // ── Detection, per sample ───────────────────────────────────────────
      for (let i = 0; i < len; i++) {
        const detRot = this.detRot.tick()
        const pathRot = this.pathRot.tick()
        let peak = 0
        let energy = 0
        for (let ch = 0; ch < nOut; ch++) {
          const s = chans[ch]
          const x = inputChannels[ch < nIn ? ch : nIn - 1][off + i]
          // The rotator always runs so its state is warm when switched in.
          let r = x
          for (let k = 0; k < s.rot.length; k++) r = s.rot[k].tick(r)
          const det = s.detHp.tick(x + detRot * (r - x))
          const lm = s.lmLp.tick(s.lmHp.tick(x))
          s.detBuf[i] = det
          s.pathBuf[i] = x + pathRot * (r - x)
          const a = det < 0 ? -det : det
          if (a > peak) peak = a
          energy += lm * lm
        }

        const trim = 1 + detRot * (this.rotTrim - 1)
        const lmNow = energy / nOut
        const voice = this.voiceEnv.tick(lmNow)
        let release = this.relSlow
        if (this.vowelRelease) {
          const voiceDb = voice > 0 ? 10 * Math.log10(voice) : -300
          const hfPrev = this.hfEnv.value
          const hfPrevDb = hfPrev > 0 ? Math.log(hfPrev) * DB_PER_NEPER : -300
          // A soft crossover rather than a switch: a hard threshold on two
          // rippling envelopes flips at a sample-rate-dependent instant, and
          // measured 0.35 dB apart at 96 kHz; blended over 6 dB it is 0.10.
          const over = Math.min(voiceDb - (tuning.voicedFloorDb + this.levelOffsetDb), voiceDb - hfPrevDb - tuning.voicedMarginDb)
          const wv = over <= -3 ? 0 : over >= 3 ? 1 : (over + 3) / 6
          release = this.relSlow + wv * (this.relVowel - this.relSlow)
        }
        this.hfEnv.release = release
        const hf = this.hfEnv.tick(peak * trim)
        const lmEnergy = this.lmEnv.tick(lmNow)
        const hfDb = hf > 0 ? Math.log(hf) * DB_PER_NEPER : -300
        const lmDb = lmEnergy > 0 ? 10 * Math.log10(lmEnergy) : -300

        const base = this.tBase.tick()
        const tEff = adaptiveThresholdDb(base, lmDb, this.kappa.tick(), tuning.lRefDb + this.levelOffsetDb, tuning.maxShiftDb)
        const target = gainComputerDb(hfDb, tEff, tuning.ratio, this.dMax.tick(), tuning.kneeDb)
        this.shelfGainDb += (target - this.shelfGainDb) * this.gainSmooth
        gainBuf[i] = this.shelfGainDb
        this.lastThresholdLiftDb = tEff - base
        if (gainOut) gainOut[off + i] = this.shelfGainDb
        if (-this.shelfGainDb > this.meterMaxReduction) this.meterMaxReduction = -this.shelfGainDb
      }

      // ── Audio path: one shelf, coefficients interpolated over the chunk ─
      // Recomputing every sample costs a cos and a sin for nothing audible;
      // every `chunk` samples is ≥ 2.7 kHz at 44.1 kHz, far above any movement
      // the 0.5 ms smoothed gain can make. Interpolating coefficients across
      // the chunk (rather than stepping them) is what keeps it zipper-free.
      this.writeShelf(next, gainBuf[len - 1])
      const listen = this.listen
      const inv = 1 / len

      for (let ch = 0; ch < nOut; ch++) {
        const s = chans[ch]
        const out = outputChannels[ch]
        const z = s.z
        const w = s.work
        for (let i = 0; i < len; i++) w[i] = s.pathBuf[i]
        for (let k = 0; k < 2; k++) {
          const o = k * 5
          const d0 = (next[o] - cur[o]) * inv
          const d1 = (next[o + 1] - cur[o + 1]) * inv
          const d2 = (next[o + 2] - cur[o + 2]) * inv
          const d3 = (next[o + 3] - cur[o + 3]) * inv
          const d4 = (next[o + 4] - cur[o + 4]) * inv
          let b0 = cur[o], b1 = cur[o + 1], b2 = cur[o + 2], a1 = cur[o + 3], a2 = cur[o + 4]
          let z1 = z[2 * k], z2 = z[2 * k + 1]
          for (let i = 0; i < len; i++) {
            b0 += d0; b1 += d1; b2 += d2; a1 += d3; a2 += d4
            const x = w[i]
            const y = b0 * x + z1
            z1 = b1 * x - a1 * y + z2
            z2 = b2 * x - a2 * y
            w[i] = y
          }
          if (Math.abs(z1) < DENORMAL_FLOOR && Math.abs(z2) < DENORMAL_FLOOR) {
            z1 = 0
            z2 = 0
          }
          z[2 * k] = z1
          z[2 * k + 1] = z2
        }
        if (listen === 'off') {
          for (let i = 0; i < len; i++) out[off + i] = w[i]
        } else if (listen === 'delta') {
          for (let i = 0; i < len; i++) out[off + i] = s.pathBuf[i] - w[i]
        } else {
          for (let i = 0; i < len; i++) out[off + i] = s.detBuf[i]
        }
        for (const bq of s.rot) bq.flushDenormals()
        s.detHp.flushDenormals()
        s.lmHp.flushDenormals()
        s.lmLp.flushDenormals()
      }
      cur.set(next)
    }

    this.meterCount += n
  }

  /**
   * Metering snapshot, at most every `meterPeriod` samples; null otherwise.
   * Reports the MAX reduction since the last snapshot, so a brief sibilant
   * that lands between two UI frames is not lost.
   */
  takeMeter() {
    if (this.meterCount < this.meterPeriod) return null
    this.meterCount = 0
    const m = {
      reductionDb: this.meterMaxReduction,
      thresholdLiftDb: this.lastThresholdLiftDb,
    }
    this.meterMaxReduction = 0
    return m
  }
}

/**
 * One-shot offline convenience: process a whole buffer through a fresh kernel.
 * Used by tests and scripts; the app renders through an OfflineAudioContext
 * running the worklet so preview and apply share one code path.
 *
 * `recordGain` returns the per-sample shelf gain in dB alongside the audio,
 * which is what the gain-reduction histogram check reads.
 */
export function processHFSoftenerBuffer(channelData, sampleRate, params = {}, { recordGain = false, listen = 'off', tuning } = {}) {
  const kernel = new HFSoftenerKernel(sampleRate, tuning)
  kernel.setParams(params, true)
  kernel.setListen(listen)

  const n = channelData[0].length
  const output = channelData.map(() => new Float32Array(n))
  const gain = recordGain ? new Float32Array(n) : null
  const BLOCK = 128
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    kernel.process(
      channelData.map(c => c.subarray(off, off + len)),
      output.map(c => c.subarray(off, off + len)),
      len,
      gain ? gain.subarray(off, off + len) : undefined,
    )
  }
  return { channelData: output, gainDb: gain }
}

/**
 * Envelope memory is 150 ms of low/mid release and 60 ms of HF release; one
 * second of pre-roll puts both far below anything audible, so an applied
 * region starts on the state a playing preview would have had.
 */
export const HF_SOFTENER_PREROLL_S = 1.0

// ── AudioWorklet registration (worklet scope only) ──────────────────────────

if (typeof registerProcessor === 'function') {
  class HFSoftenerWorkletProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super()
      this.kernel = new HFSoftenerKernel(sampleRate)
      if (options?.processorOptions?.params) {
        this.kernel.setParams(options.processorOptions.params, true)
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

      this.kernel.process(input, output, n)
      const m = this.kernel.takeMeter()
      if (m) this.port.postMessage({ type: 'gr', ...m })
      return true
    }
  }

  registerProcessor('hf-softener-processor', HFSoftenerWorkletProcessor)
}
