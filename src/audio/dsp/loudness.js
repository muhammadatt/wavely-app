/**
 * Loudness measurement — ITU-R BS.1770-4 gated LUFS, ACX's ungated RMS, and
 * the two peak readings a delivery ceiling can be stated against.
 *
 * Dependency-free, like everything else under dsp/ — it runs in the measurement
 * worker, and nothing here reaches for the DOM or for Web Audio.
 *
 * ── WHY BOTH MEASUREMENTS, AND WHY THEY ARE NOT INTERCHANGEABLE ─────────────
 * Every streaming platform states its target in LUFS: K-weighted, gated, the
 * EBU R128 measurement. ACX states its target as an unweighted, UNGATED RMS
 * over the whole file, and audits submissions with that measurement. The two
 * disagree by several dB on the same narration — K-weighting alone lifts the
 * presence band by ~4 dB before anything is averaged, and the relative gate
 * throws away the pauses that ungated RMS counts in full. So a target carries
 * its measurement method with it (see `unit` in loudnessTargets.js) and this
 * module implements both rather than converting between them, because there is
 * no conversion: the offset is a property of the material.
 *
 * ── MONO IS MEASURED AS MONO ────────────────────────────────────────────────
 * BS.1770 sums channel powers with weight 1.0 for L/R/C. A mono file is one
 * channel, so it measures 3 LU quieter than the same signal laid out as
 * dual-mono stereo — that is the specification working, not a bug, and it is
 * also what every compliant meter reports. Narration is delivered mono, so this
 * is the common path rather than a corner.
 */

/** Blocks shorter than this cannot be gated per the spec. See `blockLoudness`. */
const BLOCK_S = 0.4
/** 75% overlap, per BS.1770-4. */
const BLOCK_STEP_S = 0.1

/** The specification's absolute gate, in LKFS. */
export const ABSOLUTE_GATE_LUFS = -70
/** The relative gate, in LU below the ungated-but-absolutely-gated mean. */
export const RELATIVE_GATE_LU = 10
/** BS.1770's calibration offset, the -0.691 in l_j. */
const LOUDNESS_OFFSET_DB = -0.691

/**
 * K-weighting, as two biquads at the working sample rate.
 *
 * Both stages come from the analog prototypes BS.1770-4 tabulates at 48 kHz,
 * re-derived here through the bilinear transform so that 44.1 kHz — this app's
 * internal rate — is exact rather than approximated by 48 kHz coefficients.
 * At 48 kHz these reproduce the specification's own table.
 *
 * Stage 1 is the ~+4 dB high shelf that stands in for the head; stage 2 is the
 * ~38 Hz high-pass ("RLB") that keeps rumble out of the average.
 *
 * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}[]}
 */
export function kWeightingSections(sampleRate) {
  // Stage 1 — high shelf.
  const f0 = 1681.9744509555319
  const G = 3.999843853973347
  const Q1 = 0.7071752369554196
  const K1 = Math.tan((Math.PI * f0) / sampleRate)
  const Vh = Math.pow(10, G / 20)
  const Vb = Math.pow(Vh, 0.4996667741545416)
  const a0s = 1 + K1 / Q1 + K1 * K1
  const shelf = {
    b0: (Vh + (Vb * K1) / Q1 + K1 * K1) / a0s,
    b1: (2 * (K1 * K1 - Vh)) / a0s,
    b2: (Vh - (Vb * K1) / Q1 + K1 * K1) / a0s,
    a1: (2 * (K1 * K1 - 1)) / a0s,
    a2: (1 - K1 / Q1 + K1 * K1) / a0s,
  }

  // Stage 2 — high pass.
  const f1 = 38.13547087602444
  const Q2 = 0.5003270373238773
  const K2 = Math.tan((Math.PI * f1) / sampleRate)
  const a0h = 1 + K2 / Q2 + K2 * K2
  const hpf = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K2 * K2 - 1)) / a0h,
    a2: (1 - K2 / Q2 + K2 * K2) / a0h,
  }

  return [shelf, hpf]
}

/** Direct-form I, one section, out of place. Returns a new Float32Array. */
function runSection(x, c) {
  const n = x.length
  const y = new Float32Array(n)
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < n; i++) {
    const xi = x[i]
    const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = xi
    y2 = y1; y1 = yi
    y[i] = yi
  }
  return y
}

/** K-weight one channel. */
function kWeight(channel, sections) {
  let y = channel
  for (const c of sections) y = runSection(y, c)
  return y
}

/**
 * Integrated loudness of a region, in LUFS (LKFS — the same number).
 *
 * ⚠ MEASURED OVER THE WHOLE REGION, NEVER A CAPPED WINDOW. "Integrated" is a
 * statement about all of it, and the gating is what makes that statement
 * meaningful: a capped window that happened to land on a loud paragraph would
 * read several LU hot and the normalizer would then take the whole file down
 * to match. That is why callers of this measurement do not go through
 * `analysisWindow` the way the compressors' auto-makeup does.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @returns {number} LUFS, or -Infinity for a region with no measurable content
 */
export function measureIntegratedLufs(channelData, sampleRate) {
  const n = channelData?.[0]?.length ?? 0
  if (!n) return -Infinity

  const sections = kWeightingSections(sampleRate)
  const weighted = channelData.map(ch => kWeight(ch, sections))

  const blockN = Math.max(1, Math.round(BLOCK_S * sampleRate))
  const stepN = Math.max(1, Math.round(BLOCK_STEP_S * sampleRate))

  // ⚠ A REGION SHORTER THAN ONE BLOCK STILL GETS AN ANSWER. The spec has
  // nothing to say about 300 ms of audio, but a user who selected a short
  // phrase and asked for it to be normalized is owed a number rather than a
  // refusal — so the whole region becomes one (ungated) block. Documented
  // rather than silent: `measureLoudness` reports `short: true` so the panel
  // can say the reading is not a compliant integrated measurement.
  const blocks = []
  if (n < blockN) {
    blocks.push(meanSquares(weighted, 0, n))
  } else {
    for (let off = 0; off + blockN <= n; off += stepN) {
      blocks.push(meanSquares(weighted, off, off + blockN))
    }
  }
  if (!blocks.length) return -Infinity

  const loud = blocks.map(z => LOUDNESS_OFFSET_DB + 10 * Math.log10(sumChannels(z)))

  // Absolute gate.
  const passA = []
  for (let j = 0; j < blocks.length; j++) {
    if (loud[j] > ABSOLUTE_GATE_LUFS) passA.push(j)
  }
  if (!passA.length) return -Infinity

  // Relative gate, from the absolutely-gated mean.
  const meanA = meanOf(blocks, passA)
  const relative =
    LOUDNESS_OFFSET_DB + 10 * Math.log10(sumChannels(meanA)) - RELATIVE_GATE_LU

  const passB = passA.filter(j => loud[j] > relative)
  if (!passB.length) return -Infinity

  const meanB = meanOf(blocks, passB)
  const power = sumChannels(meanB)
  if (!(power > 0)) return -Infinity
  return LOUDNESS_OFFSET_DB + 10 * Math.log10(power)
}

/** Per-channel mean square over [from, to). */
function meanSquares(weighted, from, to) {
  const len = to - from
  return weighted.map(ch => {
    let s = 0
    for (let i = from; i < to; i++) s += ch[i] * ch[i]
    return s / len
  })
}

/**
 * Σ G_i z_i, with G = 1.0 for every channel.
 *
 * The 1.41 surround weights are deliberately absent: this app decodes to mono
 * or stereo and nothing downstream can produce a surround buffer, so a weight
 * table indexed by channel count would be untested code standing between the
 * measurement and its answer.
 */
function sumChannels(z) {
  let s = 0
  for (const v of z) s += v
  return s
}

/** Mean of the per-channel mean squares over a set of block indices. */
function meanOf(blocks, indices) {
  const chans = blocks[0].length
  const out = new Array(chans).fill(0)
  for (const j of indices) {
    for (let c = 0; c < chans; c++) out[c] += blocks[j][c]
  }
  for (let c = 0; c < chans; c++) out[c] /= indices.length
  return out
}

/**
 * Ungated, unweighted RMS over the whole region, in dBFS — ACX's measurement.
 *
 * ⚠ UNGATED IS THE POINT AND IT IS NOT AN OVERSIGHT. ACX measures the file as
 * submitted, pauses and room tone included, which is why a narrator who runs a
 * gated meter reads several dB louder than ACX does and fails a check they
 * thought they had passed. Channels are pooled by mean power, matching
 * FFmpeg's `volumedetect` — the measurement the server pipeline normalizes
 * against for the `acx` output profile.
 */
export function measureRmsDb(channelData) {
  let sum = 0
  let count = 0
  for (const ch of channelData ?? []) {
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i]
    count += ch.length
  }
  if (!count || !(sum > 0)) return -Infinity
  return 10 * Math.log10(sum / count)
}

/** Loudest single sample in the region, in dBFS. */
export function measureSamplePeakDb(channelData) {
  let pk = 0
  for (const ch of channelData ?? []) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i]
      if (a > pk) pk = a
    }
  }
  return pk > 0 ? 20 * Math.log10(pk) : -Infinity
}

// ── True peak ───────────────────────────────────────────────────────────────

/** Oversampling factor for the true-peak estimate, per BS.1770-4 Annex 2. */
const TP_OVERSAMPLE = 4
/** Taps per polyphase branch. 12 gives a 48-tap prototype, as the spec's does. */
const TP_TAPS_PER_PHASE = 12
/**
 * Only samples within this many dB of the loudest one are interpolated.
 *
 * A band-limited signal's inter-sample peak cannot exceed the nearest sample by
 * more than about 0.9 dB, so nothing 6 dB down can possibly become the true
 * peak — and skipping those turns a whole-region 48-tap convolution into one
 * over the handful of samples that could win it. That is what lets the
 * normalizer re-measure true peak on every iteration of its limiter solve
 * without the cost mattering: on real narration this touches well under 1% of
 * the samples.
 */
const TP_SCREEN_DB = 6

function besselI0(x) {
  let s = 1, t = 1
  for (let k = 1; k < 40; k++) {
    t *= (x / (2 * k)) * (x / (2 * k))
    s += t
    if (t < 1e-16 * s) break
  }
  return s
}

/**
 * Polyphase interpolation branches for the true-peak estimate.
 *
 * ⚠ GENERATED, NOT TRANSCRIBED. BS.1770-4 prints a specific coefficient table;
 * reproducing 48 numbers from memory is exactly the kind of thing that is
 * wrong in one digit and silently reads 0.3 dB low forever. A Kaiser-windowed
 * sinc built here is the same construction the spec's table is, is checkable
 * from its own definition, and `test/dsp/loudness.test.js` pins the properties
 * that matter: unity DC gain on every branch, and a half-sample-offset sine
 * reading its real peak to within 0.05 dB.
 */
const TP_PHASES = (() => {
  const len = TP_OVERSAMPLE * TP_TAPS_PER_PHASE
  const beta = 8.0
  const centre = (len - 1) / 2
  const proto = new Float64Array(len)
  const i0b = besselI0(beta)
  for (let i = 0; i < len; i++) {
    const t = (i - centre) / TP_OVERSAMPLE
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)
    const r = (2 * i) / (len - 1) - 1
    proto[i] = sinc * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b)
  }
  // Split into branches, then normalise each to unity DC so that a constant
  // input interpolates to itself — without which every phase would carry its
  // own small gain error straight into the reading.
  const phases = []
  for (let p = 0; p < TP_OVERSAMPLE; p++) {
    const taps = new Float64Array(TP_TAPS_PER_PHASE)
    let sum = 0
    for (let k = 0; k < TP_TAPS_PER_PHASE; k++) {
      taps[k] = proto[k * TP_OVERSAMPLE + p]
      sum += taps[k]
    }
    for (let k = 0; k < TP_TAPS_PER_PHASE; k++) taps[k] /= sum
    phases.push(taps)
  }
  return phases
})()

/** Exposed for the test that pins the branches' DC gain and symmetry. */
export const TRUE_PEAK_PHASES = TP_PHASES

/**
 * Largest inter-sample peak in the region, in dBTP.
 *
 * Always >= the sample peak: the sample values themselves are one of the four
 * phases (the branches interpolate through them), so the reading can only go
 * up from there.
 */
export function measureTruePeakDb(channelData) {
  const chans = channelData ?? []
  if (!(chans[0]?.length > 0)) return -Infinity

  let samplePk = 0
  for (const ch of chans) {
    for (let i = 0; i < ch.length; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i]
      if (a > samplePk) samplePk = a
    }
  }
  if (!(samplePk > 0)) return -Infinity

  const screen = samplePk * Math.pow(10, -TP_SCREEN_DB / 20)
  const half = TP_TAPS_PER_PHASE >> 1
  let peak = samplePk

  // ⚠ OUTSIDE THE REGION READS AS ZERO, WHICH CAN ONLY READ HIGH. A region
  // boundary that lands mid-waveform is a step as far as the interpolator is
  // concerned, and it rings: measured on a 5 kHz tone cut at a non-zero sample,
  // +0.49 dB. That is the honest answer for a region rendered on its own — the
  // discontinuity is really there in what gets written back — and erring high
  // is the safe direction for something a peak ceiling is set from.
  for (const ch of chans) {
    const chN = ch?.length ?? 0
    if (!chN) continue
    for (let i = 0; i < chN; i++) {
      const a = ch[i] < 0 ? -ch[i] : ch[i]
      if (a < screen) continue
      // The peaks between this sample and its neighbours on both sides.
      for (let j = i - 1; j <= i; j++) {
        if (j < 0) break
        for (let p = 1; p < TP_OVERSAMPLE; p++) {
          const taps = TP_PHASES[p]
          let acc = 0
          for (let k = 0; k < TP_TAPS_PER_PHASE; k++) {
            const idx = j - half + 1 + k
            if (idx >= 0 && idx < chN) acc += taps[k] * ch[idx]
          }
          const b = acc < 0 ? -acc : acc
          if (b > peak) peak = b
        }
      }
    }
  }

  return 20 * Math.log10(peak)
}

/**
 * Every reading the loudness normalizer works from, in one pass over the
 * region.
 *
 * `short` marks a region below the 400 ms BS.1770 block: `lufs` is then a
 * single ungated block rather than an integrated measurement, and the panel
 * says so rather than presenting it as compliant.
 *
 * @returns {{lufs:number, rmsDb:number, samplePeakDb:number, truePeakDb:number,
 *   short:boolean, durationS:number}}
 */
export function measureLoudness(channelData, sampleRate) {
  const n = channelData?.[0]?.length ?? 0
  return {
    lufs: measureIntegratedLufs(channelData, sampleRate),
    rmsDb: measureRmsDb(channelData),
    samplePeakDb: measureSamplePeakDb(channelData),
    truePeakDb: measureTruePeakDb(channelData),
    short: n > 0 && n < Math.round(BLOCK_S * sampleRate),
    durationS: sampleRate > 0 ? n / sampleRate : 0,
  }
}
