/**
 * LA-2A electro-optical leveling amplifier emulation.
 *
 * Pure JS, dependency-free — runs in the process worker (browser) and in
 * plain Node for offline verification. Models the three defining behaviors
 * of the hardware rather than a generic threshold/ratio compressor:
 *
 * 1. T4 optical cell (electroluminescent panel + LDR pair)
 *    - Fixed ~10 ms attack (the panel's turn-on time; not user-adjustable
 *      on the hardware).
 *    - Dual-stage release: a fast stage recovers ~50% of the gain reduction
 *      in 50–60 ms, followed by a slow phosphorescent tail.
 *    - LDR memory: the slow tail's time constant stretches from ~0.5 s to
 *      ~5 s depending on how hard and how long the panel was previously lit.
 *
 * 2. Program-dependent ratio
 *    - Compress mode: gentle, wide-knee curve whose effective ratio drifts
 *      from ~3:1 toward ~4:1 as the sidechain is driven harder.
 *    - Limit mode: narrower knee, ratio climbing from ~12:1 toward ~20:1.
 *    - There is no threshold control on the hardware: the Peak Reduction
 *      knob is sidechain amplifier gain, driving the signal into a fixed
 *      internal threshold. Modeled the same way here.
 *
 * 3. Sidechain frequency mapping + tube stage
 *    - Sidechain: one-pole 80 Hz high-pass (the cell barely responds to
 *      rumble) plus an R37-style HF emphasis shelf (0 to +8 dB above 2 kHz)
 *      that makes the unit progressively de-ess as it's turned up.
 *    - Output path: asymmetric tanh waveshaper approximating the harmonic
 *      profile of the input/driver/output tube stages (bias term → 2nd
 *      harmonic, tanh curvature → 3rd), followed by a DC blocker.
 */

// ── T4 optical cell constants ───────────────────────────────────────────────

const ATTACK_S = 0.010 // EL panel turn-on

// Fraction of gain reduction held by the fast stage, and its release tau.
// Together tuned so total recovery hits ~50% at 50–60 ms regardless of the
// slow tail's current length.
const FAST_FRACTION = 0.65
const FAST_RELEASE_S = 0.035

// Slow-tail release range; position within the range is driven by the
// LDR memory state.
const SLOW_RELEASE_MIN_S = 0.5
const SLOW_RELEASE_MAX_S = 5.0

// LDR memory: integrates gain reduction over time. Charges while the panel
// is lit, bleeds off slowly after. MEM_HALF_DB is the accumulated level (dB
// of GR) at which the slow tail sits halfway through its range.
const MEM_CHARGE_S = 0.8
const MEM_DISCHARGE_S = 8.0
const MEM_HALF_DB = 2.5

// ── Sidechain constants ─────────────────────────────────────────────────────

const SC_HPF_HZ = 80
const SC_SHELF_HZ = 2000
const SC_SHELF_MAX_DB = 8
const DETECTOR_S = 0.0005 // light rectifier smoothing; the T4 model supplies the real ballistics

// ── Gain computer constants ─────────────────────────────────────────────────

const COMPRESS_KNEE_DB = 20 // wide knee — the "leveling" feel
const LIMIT_KNEE_DB = 6

// Slow-tail coefficient refresh interval. The memory state moves on ~1 s
// time scales, so per-sample Math.exp would be pure waste.
const COEFF_BLOCK = 32

const LN10_OVER_20 = Math.LN10 / 20

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Process a buffer through the LA-2A model.
 *
 * @param {Float32Array[]} channelData - One Float32Array per channel
 * @param {number} sampleRate
 * @param {object} [params]
 * @param {'compress'|'limit'} [params.mode]  - Compress (~3–4:1) or Limit (~12–20:1)
 * @param {number} [params.peakReduction]     - 0–100, sidechain drive (hardware Peak Reduction knob)
 * @param {number} [params.gainDb]            - Makeup gain in dB (hardware Gain knob)
 * @param {number} [params.tubeDrive]         - 0–1, tube stage saturation amount
 * @param {number} [params.emphasis]          - 0–1, R37 HF sidechain emphasis (0 = flat)
 * @param {number} [params.mix]               - 0–1 wet/dry blend
 * @returns {{ channelData: Float32Array[], metering: { maxGainReductionDb: number, avgGainReductionDb: number } }}
 */
export function processLA2A(channelData, sampleRate, params = {}) {
  const {
    mode = 'compress',
    peakReduction = 50,
    gainDb = 0,
    tubeDrive = 0.3,
    emphasis = 0,
    mix = 1,
  } = params

  const n = channelData[0].length
  const numChannels = channelData.length
  const isLimit = mode === 'limit'
  const kneeDb = isLimit ? LIMIT_KNEE_DB : COMPRESS_KNEE_DB
  const halfKnee = kneeDb / 2

  // Peak Reduction 0–100 → sidechain gain -20..+20 dB into a fixed 0 dBFS
  // internal threshold.
  const scDriveDb = -20 + 0.4 * clamp(peakReduction, 0, 100)

  const attackCoef = 1 - Math.exp(-1 / (sampleRate * ATTACK_S))
  const fastRelCoef = 1 - Math.exp(-1 / (sampleRate * FAST_RELEASE_S))
  const detCoef = 1 - Math.exp(-1 / (sampleRate * DETECTOR_S))
  const memChargeCoef = 1 - Math.exp(-1 / (sampleRate * MEM_CHARGE_S))
  const memDischargeCoef = 1 - Math.exp(-1 / (sampleRate * MEM_DISCHARGE_S))

  // One-pole sidechain filters (lowpass state; highpass = input - lowpass)
  const hpfLpCoef = 1 - Math.exp(-2 * Math.PI * SC_HPF_HZ / sampleRate)
  const shelfLpCoef = 1 - Math.exp(-2 * Math.PI * SC_SHELF_HZ / sampleRate)
  const shelfGain = Math.pow(10, (SC_SHELF_MAX_DB * clamp(emphasis, 0, 1)) / 20) - 1

  // ── Pass 1: mono sidechain → per-sample linear gain curve ────────────────
  const gainCurve = new Float32Array(n)
  const chScale = 1 / numChannels

  let hpfLp = 0 // 80 Hz HPF lowpass state
  let shelfLp = 0 // emphasis shelf lowpass state
  let env = 0 // rectifier envelope
  let grFast = 0 // fast-stage gain reduction (dB)
  let grSlow = 0 // slow-stage gain reduction (dB)
  let memory = 0 // LDR excitation memory (dB-weighted)
  let slowRelCoef = 1 - Math.exp(-1 / (sampleRate * SLOW_RELEASE_MIN_S))

  const makeupLin = Math.exp(gainDb * LN10_OVER_20)
  let maxGr = 0
  let grSum = 0
  let grActive = 0

  for (let i = 0; i < n; i++) {
    // Refresh the slow-release coefficient from the LDR memory state.
    if (i % COEFF_BLOCK === 0) {
      const memNorm = memory / (memory + MEM_HALF_DB)
      const slowTau = SLOW_RELEASE_MIN_S + (SLOW_RELEASE_MAX_S - SLOW_RELEASE_MIN_S) * memNorm
      slowRelCoef = 1 - Math.exp(-1 / (sampleRate * slowTau))
    }

    // Mono sidechain tap
    let x = channelData[0][i]
    for (let ch = 1; ch < numChannels; ch++) x += channelData[ch][i]
    x *= chScale

    // Sidechain frequency mapping: 80 Hz HPF, then HF emphasis shelf
    hpfLp += (x - hpfLp) * hpfLpCoef
    const hp = x - hpfLp
    let sc = hp
    if (shelfGain > 0) {
      shelfLp += (hp - shelfLp) * shelfLpCoef
      sc = hp + shelfGain * (hp - shelfLp)
    }

    // Rectify + light smoothing
    const rect = sc < 0 ? -sc : sc
    env += (rect - env) * detCoef

    // Static curve: overshoot above the fixed internal threshold after
    // sidechain drive; ratio itself is program-dependent (grows with drive).
    const levelDb = env > 1e-6 ? 20 * Math.log10(env) : -120
    const over = levelDb + scDriveDb
    let grTarget = 0
    if (over > -halfKnee) {
      const ratio = isLimit
        ? 12 + 8 * (over > 0 ? over / (over + 6) : 0)
        : 3 + (over > 0 ? over / (over + 10) : 0)
      const slope = 1 - 1 / ratio
      if (over <= halfKnee) {
        const t = over + halfKnee
        grTarget = slope * t * t / (2 * kneeDb)
      } else {
        grTarget = slope * over
      }
    }

    // LDR memory: charges while gain reduction is demanded, bleeds off after
    memory += (grTarget - memory) * (grTarget > memory ? memChargeCoef : memDischargeCoef)

    // T4 dynamics. Attack splits the incoming reduction across both stages
    // so a release from any state recovers ~50% at the fast rate. Release
    // decays each stage toward its share of the current target (not zero)
    // so sustained program holds its reduction.
    const gr = grFast + grSlow
    if (grTarget > gr) {
      const delta = (grTarget - gr) * attackCoef
      grFast += delta * FAST_FRACTION
      grSlow += delta * (1 - FAST_FRACTION)
    } else {
      grFast += (grTarget * FAST_FRACTION - grFast) * fastRelCoef
      grSlow += (grTarget * (1 - FAST_FRACTION) - grSlow) * slowRelCoef
    }

    const grNow = grFast + grSlow
    if (grNow > maxGr) maxGr = grNow
    if (grNow > 0.05) {
      grSum += grNow
      grActive++
    }
    gainCurve[i] = Math.exp(-grNow * LN10_OVER_20) * makeupLin
  }

  // ── Pass 2: apply gain curve + tube stage per channel ────────────────────
  // Drive can go sub-unity (slope is normalized back to 1 below): at the
  // default amount a -6 dBFS peak lands around H3 ≈ -40 dBc — tube warmth
  // at nominal level, not overdrive. Max amount reaches ~-22 dBc.
  const applyTube = tubeDrive > 0
  const drive = 0.25 + 1.5 * clamp(tubeDrive, 0, 1)
  const bias = 0.2 * clamp(tubeDrive, 0, 1)
  const tanhBias = Math.tanh(bias)
  // Normalize so the shaper has unity small-signal gain
  const tubeNorm = drive * (1 - tanhBias * tanhBias)
  // DC blocker pole (~5 Hz) — the asymmetric shaper shifts the operating point
  const dcR = 1 - 2 * Math.PI * 5 / sampleRate

  const wetMix = clamp(mix, 0, 1)
  const dryMix = 1 - wetMix

  const output = []
  for (let ch = 0; ch < numChannels; ch++) {
    const input = channelData[ch]
    const out = new Float32Array(n)
    let dcX = 0
    let dcY = 0
    for (let i = 0; i < n; i++) {
      const dry = input[i]
      let wet = dry * gainCurve[i]
      if (applyTube) {
        const shaped = (Math.tanh(drive * wet + bias) - tanhBias) / tubeNorm
        dcY = shaped - dcX + dcR * dcY
        dcX = shaped
        wet = dcY
      }
      out[i] = dry * dryMix + wet * wetMix
    }
    output.push(out)
  }

  return {
    channelData: output,
    metering: {
      maxGainReductionDb: maxGr,
      avgGainReductionDb: grActive > 0 ? grSum / grActive : 0,
    },
  }
}
