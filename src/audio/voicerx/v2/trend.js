/**
 * VoiceRx v2 — log-frequency grid, validity mask, and the trend the whole
 * detector measures against.
 *
 * THE TREND REPLACES THE CHORD. v1 builds its reference by taking the median of
 * a 0.4-octave window either side of a scan region and drawing a straight line
 * between them in log-frequency. That is exact only if the envelope is straight
 * between the two anchors, and a voice envelope is not: it curves. A chord
 * across a convex roll-off sits below the curve throughout, so the region reads
 * as a hump and gets cut. On the reference clip that is a 7.9 dB cut at 609 Hz
 * with no resonance anywhere near it.
 *
 * A robust local fit has no anchors to be wrong about. It estimates the level
 * at every frequency from the spectrum around that frequency, weighted by
 * distance and de-weighted by how far each point sits from the emerging fit —
 * so a resonance, being a minority of its neighbourhood, is excluded from the
 * reference it will be measured against. Measured against the corpus this beat
 * the chord on real defects AND on false ones simultaneously, which is the
 * signature of a better estimator rather than a differently-tuned one.
 *
 * DEGREE TWO, NOT ONE. Curvature is the thing the chord misses, and a local
 * LINEAR fit reproduces exactly the same blind spot at a smaller scale. A
 * quadratic follows curvature to second order, which is as much as the envelope
 * has over any window this size.
 */

/** Grid resolution, in octaves. */
export const GRID_OCTAVES = 1 / 24

/**
 * Half-width of the local fit, in octaves.
 *
 * The one parameter that genuinely matters, and it was measured rather than
 * chosen. A degree-2 polynomial IS the shape of a broad bump, so a window only
 * a little wider than a resonance fits the resonance instead of the spectrum
 * around it — at 1.5 octaves a planted +12 dB peak at 300 Hz left a residual of
 * 1.5 dB and went undetected, because 300 Hz sits on this voice's own spectral
 * maximum where a parabola fits beautifully.
 *
 * Swept against the corpus, residual left by a +12 dB defect:
 *
 *   span   300 Hz   700 Hz   3 kHz   worst on a CLEAN voice
 *   1.0     0.59     6.38     8.94    1.28
 *   1.5     1.49     7.53     9.74    1.34
 *   2.5     2.25     8.44    11.05    1.49
 *   3.0     2.77     8.48    11.19    1.96
 *
 * Sensitivity climbs with width and specificity barely suffers until 3.0, where
 * the fit starts to straighten and the clean residual jumps. 2.5 takes nearly
 * all the available sensitivity for almost none of the cost.
 *
 * 300 Hz stays hard at every width. A defect centred on the spectrum's own peak
 * is the worst case for any smooth reference, and no span setting rescues it —
 * which is worth knowing rather than tuning around.
 */
export const SPAN_OCTAVES = 2.5

/** IRLS rounds. Two is enough to reject a peak; the third barely moves. */
const ROBUST_ROUNDS = 3

/**
 * Per-frequency SNR below which the spectrum is not reporting the voice.
 *
 * 6 dB, which is generous on purpose — it is a floor for "there is something
 * here", not a quality bar. Above a bandwidth edge the measured SNR falls to
 * nothing; inside even a deep notch it stays far above this. That gap is what
 * lets one mask handle brick-walled files, dead bands and DC rumble without any
 * of them being a special case.
 */
const MIN_SNR_DB = 6

/**
 * Resample a bin-sampled curve onto a uniform log-frequency grid.
 *
 * Everything downstream measures widths and spans in octaves, and only a
 * log-uniform grid makes those fixed numbers of samples rather than a search at
 * every point.
 */
export function toLogGrid(freqsHz, valuesDb, loHz, hiHz) {
  const n = Math.floor(Math.log2(hiHz / loHz) / GRID_OCTAVES) + 1
  const hz = new Float64Array(n)
  const db = new Float64Array(n)
  const step = freqsHz[1] - freqsHz[0]
  const last = freqsHz.length - 1

  for (let i = 0; i < n; i++) {
    const f = loHz * Math.pow(2, i * GRID_OCTAVES)
    hz[i] = f
    const x = f / step
    const k = Math.min(last - 1, Math.max(0, Math.floor(x)))
    const t = x - k
    db[i] = valuesDb[k] * (1 - t) + valuesDb[k + 1] * t
  }
  return { hz, db, n }
}

/**
 * Which grid points carry voice.
 *
 * When no noise floor could be measured — a selection with no pauses in it —
 * everything within a wide window of the peak is treated as live. That is the
 * honest fallback: without pauses there is no evidence about where the voice
 * stops, and inventing a threshold is what v1 does.
 */
export function buildMask(gridDb, noiseGridDb, n) {
  const mask = new Uint8Array(n)
  const snrDb = new Float64Array(n)

  if (!noiseGridDb) {
    let peak = -Infinity
    for (let i = 0; i < n; i++) peak = Math.max(peak, gridDb[i])
    for (let i = 0; i < n; i++) {
      snrDb[i] = NaN
      mask[i] = gridDb[i] > peak - 70 ? 1 : 0
    }
    return { mask, snrDb, measured: false }
  }

  for (let i = 0; i < n; i++) {
    snrDb[i] = gridDb[i] - noiseGridDb[i]
    mask[i] = snrDb[i] >= MIN_SNR_DB ? 1 : 0
  }
  return { mask, snrDb, measured: true }
}

/** Solve a 3x3 system by Gaussian elimination with partial pivoting. */
function solve3(A, b) {
  const M = [
    [A[0], A[1], A[2], b[0]],
    [A[1], A[3], A[4], b[1]],
    [A[2], A[4], A[5], b[2]],
  ]
  for (let c = 0; c < 3; c++) {
    let p = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-10) return null
    const tmp = M[c]
    M[c] = M[p]
    M[p] = tmp
    for (let r = 0; r < 3; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M[0][3] / M[0][0]
}

function medianOf(values) {
  if (!values.length) return 0
  const s = Float64Array.from(values).sort()
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Robust local quadratic fit over the masked grid.
 *
 * Returns the trend at every grid point, plus how much usable data each fit
 * had. That second number is not diagnostic padding — a fit whose window was
 * half masked is a weaker statement than one with a full window, and the
 * confidence stage needs to know which it is looking at.
 */
export function robustTrend(gridDb, mask, n, spanOctaves = SPAN_OCTAVES) {
  const w = Math.max(2, Math.round(spanOctaves / GRID_OCTAVES))
  const trend = new Float64Array(n)
  const support = new Float64Array(n)
  const robust = new Float64Array(n).fill(1)
  const A = new Float64Array(6)
  const b = new Float64Array(3)

  for (let round = 0; round <= ROBUST_ROUNDS; round++) {
    for (let i = 0; i < n; i++) {
      A.fill(0)
      b.fill(0)
      let used = 0
      let weight = 0

      for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) {
        if (!mask[j]) continue
        const x = (j - i) * GRID_OCTAVES
        const u = Math.abs(x) / ((w + 1) * GRID_OCTAVES)
        const tri = (1 - Math.min(1, u) ** 3) ** 3
        const wt = tri * robust[j]
        if (wt <= 0) continue
        used++
        weight += wt

        const x2 = x * x
        A[0] += wt
        A[1] += wt * x
        A[2] += wt * x2
        A[3] += wt * x2
        A[4] += wt * x2 * x
        A[5] += wt * x2 * x2
        b[0] += wt * gridDb[j]
        b[1] += wt * x * gridDb[j]
        b[2] += wt * x2 * gridDb[j]
      }

      // A window with almost nothing in it cannot support a quadratic. Falling
      // back to the sample itself makes the residual zero there, which is the
      // right answer: no reference means no claim, not a claim of zero.
      const fitted = used >= 6 ? solve3(A, b) : null
      trend[i] = fitted === null ? gridDb[i] : fitted
      if (round === 0) support[i] = weight / (2 * w + 1)
    }

    if (round === ROBUST_ROUNDS) break

    const residuals = []
    for (let i = 0; i < n; i++) if (mask[i]) residuals.push(Math.abs(gridDb[i] - trend[i]))
    const mad = medianOf(residuals) || 1e-9
    for (let i = 0; i < n; i++) {
      // Tukey biweight at six MADs. A resonance sits far outside that and is
      // weighted out of the reference it is about to be measured against; the
      // ordinary corrugation of a formant envelope sits inside it and is kept,
      // because that corrugation IS the voice and a trend that ignored it would
      // report the whole spectrum as anomalous.
      const u = Math.abs(gridDb[i] - trend[i]) / (6 * mad)
      robust[i] = u >= 1 ? 0 : (1 - u * u) ** 2
    }
  }

  return { trend, support }
}
