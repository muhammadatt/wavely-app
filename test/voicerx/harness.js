/**
 * Scoring engine for the VoiceRx corpus.
 *
 * Takes a detector, runs it over every case, and reduces the results to numbers
 * that say whether it works. The detector is a parameter rather than an import
 * so that a replacement can be scored on the identical corpus and the two
 * scorecards diffed — which is the whole point of having this.
 *
 * WHAT EACH METRIC IS FOR. They are not interchangeable and a single headline
 * score would hide the failures that matter:
 *
 *  - `detectionRate` catches blind spots. A region scanned in only one
 *    direction cannot report a defect of the other sign at all, and no amount
 *    of accuracy elsewhere compensates.
 *  - `recovery` catches miscalibration. It is the fraction of the planted
 *    defect the detector actually undoes, so 1.0 is exact and 0.5 is half a
 *    fix. The SPREAD matters more than the median: identical defects at
 *    different frequencies should be corrected by the same fraction, and when
 *    they are not, the per-region constants disagree with each other.
 *  - `spurious` catches invention. Bands that match no planted defect are
 *    corrections to a voice that did not need them, and they are weighted by
 *    gain because a 0.5 dB phantom is noise while an 8 dB one is damage.
 *  - `freqError` catches aim. A correction 0.4 octaves from the resonance is
 *    cutting something else.
 *
 * Reported as plain JSON so a scorecard can be committed and diffed.
 */

import { renderCase, SR } from './signals.js'

/**
 * How close a band has to be to a planted defect to count as addressing it.
 *
 * Half an octave, and generous on purpose. The question this answers is "did
 * the detector find the thing", not "did it find it precisely" — precision is
 * `freqError`'s job, reported separately so a near-miss shows up as poor aim
 * rather than silently as a miss plus a phantom. Tightening this would double-
 * count one error in two metrics.
 */
const MATCH_OCTAVES = 0.5

/** Bands smaller than this are below what anyone would hear as a change. */
const NEGLIGIBLE_GAIN_DB = 0.1

function octavesApart(a, b) {
  return Math.abs(Math.log2(a / b))
}

function median(values) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function quantile(values, q) {
  if (!values.length) return null
  const s = [...values].sort((a, b) => a - b)
  const i = (s.length - 1) * q
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

function round(v, places = 3) {
  if (v === null || !Number.isFinite(v)) return v
  const f = 10 ** places
  return Math.round(v * f) / f
}

/**
 * Score one case.
 *
 * Each planted defect claims the bands within MATCH_OCTAVES of it; whatever is
 * left over is spurious. A defect is "detected" only if the net correction near
 * it points the right way — a +3 dB boost sitting on a planted resonance is not
 * a partial fix, it is a second defect, and counting it as a detection would
 * let a detector score well by emitting bands at random.
 */
export function scoreCase(spec, output) {
  const bands = (output.bands ?? []).filter(b => Math.abs(b.gainDb) >= NEGLIGIBLE_GAIN_DB)
  const claimed = new Set()
  const defects = []

  for (const defect of spec.defects ?? []) {
    const idealGainDb = -defect.gainDb
    const near = bands.filter(b => octavesApart(b.freqHz, defect.freqHz) <= MATCH_OCTAVES)

    // ONLY BANDS PUSHING THE RIGHT WAY COUNT AS ADDRESSING THE DEFECT. A boost
    // sitting on a planted resonance is not a weak fix, it is a second defect,
    // and claiming it here would hide it from the spurious tally — leaving a
    // detector that makes the audio actively worse scoring identically to one
    // that stayed silent. Both would show one miss and nothing else.
    const helping = near.filter(b => Math.sign(b.gainDb) === Math.sign(idealGainDb))
    for (const b of helping) claimed.add(b)

    // Recovery is still the NET of everything nearby: what reaches the audio is
    // the sum, and a correction half undone by its neighbour has half recovered.
    const appliedGainDb = near.reduce((sum, b) => sum + b.gainDb, 0)
    const rightWay = Math.sign(appliedGainDb) === Math.sign(idealGainDb)
    // Aim is judged by the band doing most of the work, not by an average that
    // a small opposite-signed neighbour could drag anywhere.
    const dominant = helping.reduce(
      (best, b) => (best === null || Math.abs(b.gainDb) > Math.abs(best.gainDb) ? b : best), null,
    )

    defects.push({
      freqHz: defect.freqHz,
      plantedGainDb: defect.gainDb,
      detected: helping.length > 0 && rightWay,
      appliedGainDb: round(appliedGainDb, 2),
      recovery: round(appliedGainDb / idealGainDb, 3),
      freqErrorOctaves: dominant ? round(octavesApart(dominant.freqHz, defect.freqHz), 3) : null,
      bandCount: near.length,
    })
  }

  const spurious = bands.filter(b => !claimed.has(b))

  return {
    name: spec.name,
    family: spec.family,
    ok: output.ok !== false,
    reason: output.ok === false ? output.reason : undefined,
    defects,
    spuriousBands: spurious.length,
    spuriousGainDb: round(spurious.reduce((s, b) => s + Math.abs(b.gainDb), 0), 2),
    spurious: spurious.map(b => ({ freqHz: round(b.freqHz, 1), gainDb: round(b.gainDb, 2) })),
    advisories: (output.advisories ?? []).length,
  }
}

/** Reduce a set of case results to the numbers that describe a detector. */
export function summarise(results) {
  const allDefects = results.flatMap(r => r.defects)
  const detected = allDefects.filter(d => d.detected)
  const recoveries = detected.map(d => d.recovery)
  const freqErrors = detected.map(d => d.freqErrorOctaves).filter(v => v !== null)
  // Every case where the right answer is "no correction" — clean controls, but
  // also notches and bandwidth edges, where something WAS done to the audio and
  // the correct response is still an advisory or silence rather than a band.
  const noCorrectionExpected = results.filter(r => r.defects.length === 0)

  return {
    cases: results.length,
    plantedDefects: allDefects.length,
    detected: detected.length,
    detectionRate: allDefects.length ? round(detected.length / allDefects.length) : null,
    missed: allDefects.filter(d => !d.detected).map(d => `${d.freqHz}Hz ${d.plantedGainDb > 0 ? '+' : ''}${d.plantedGainDb}dB`),
    recovery: {
      median: round(median(recoveries)),
      p10: round(quantile(recoveries, 0.1)),
      p90: round(quantile(recoveries, 0.9)),
      // The headline number for calibration: how much the correction fraction
      // swings across defects that are identical apart from where they sit.
      spread: round(quantile(recoveries, 0.9) - quantile(recoveries, 0.1)),
    },
    freqErrorOctaves: {
      median: round(median(freqErrors)),
      max: round(freqErrors.length ? Math.max(...freqErrors) : null),
    },
    spuriousBands: results.reduce((s, r) => s + r.spuriousBands, 0),
    spuriousGainDb: round(results.reduce((s, r) => s + r.spuriousGainDb, 0), 2),
    noCorrectionExpected: noCorrectionExpected.length,
    noCorrectionButGotBands: noCorrectionExpected.filter(r => r.spuriousBands > 0).length,
    analysisFailures: results.filter(r => !r.ok).length,
  }
}

/**
 * Run a detector over a list of case specs and produce a full scorecard.
 *
 * @param {(audio: Float32Array, sampleRate: number) => object} detector
 * @param {Array<object>} cases
 */
export function runScorecard(detector, cases) {
  const results = cases.map(spec => scoreCase(spec, detector(renderCase(spec), SR)))

  const families = {}
  for (const family of [...new Set(results.map(r => r.family))]) {
    families[family] = summarise(results.filter(r => r.family === family))
  }

  return { overall: summarise(results), families, results }
}
