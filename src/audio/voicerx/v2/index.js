/**
 * VoiceRx v2 — measure, find, believe, correct.
 *
 * NOT WIRED INTO THE APP. This exists to be scored against the same corpus as
 * the shipping detector (`npm run scorecard --detector=v2`). Nothing imports it
 * outside the harness, and it stays that way until the numbers say it should
 * not.
 *
 * The pipeline, and what each stage replaces:
 *
 *   measure    voiced envelope, its two halves, and the noise floor
 *              -> the halves and the floor are both new; v1 measures neither
 *   mask       per-frequency SNR
 *              -> replaces DEAD_REGION_DB, no_energy and flatBaseline
 *   trend      robust local quadratic
 *              -> replaces the two-anchor chord and its curvature blind spot
 *   features   extrema of the residual, continuously
 *              -> replaces nine fixed regions, mergeBands, and the directional
 *                 blind spots that make a hump at 1.5 kHz undetectable
 *   confidence four independent doubts, multiplied
 *              -> replaces the caps, and the spectral-hole guard
 *   policy     gain = -height x confidence
 *              -> replaces per-region SCALE, MAX_CUT_DB, MAX_BOOST_DB and the
 *                 three-pass correction loop
 *
 * Sixty-three hand-set constants in two region tables become six here, and none
 * of the six is per-frequency. That is the claim this has to earn on the corpus.
 */

import { REGION_SPAN_HZ, classifyVoice, regionAtHz } from '../regions.js'
import { roleForRegion } from '../../eqBands.js'
import { measure } from './envelope.js'
import { toLogGrid, buildMask, robustTrend, GRID_OCTAVES } from './trend.js'
import { findFeatures } from './features.js'
import { scoreConfidence } from './confidence.js'

/**
 * Largest correction the detector will make on its own, before confidence.
 *
 * One number rather than nine, because there is no measured reason for the
 * ceiling to differ by frequency and v1's per-region caps are demonstrably
 * inconsistent with each other — the corpus shows recovery swinging from 0.26
 * to 0.74 across defects identical apart from where they sit.
 */
const MAX_CORRECTION_DB = 8

/**
 * The same ceiling for boosts, which is lower for the reason set out beside
 * IMPLAUSIBLE_DEFICIENCY_DB: a boost lifts the band's noise floor with it and a
 * cut does not, so the two are not mirror images and should not share a limit.
 */
const MAX_BOOST_DB = 5

/**
 * How far past the reported range the analysis grid extends, in octaves.
 *
 * A FULL TWO-SIDED WINDOW AT THE BOUNDARIES IS NOT ACHIEVABLE, and an earlier
 * version of this comment claimed otherwise. Satisfying it would need
 * SPAN_OCTAVES of margin — 16 kHz plus 2.5 octaves is 90 kHz, against a Nyquist
 * of 22.05 — so at the top the grid is clamped and the fits up there really are
 * one-sided whatever this constant says. What handles that is `conditioning`,
 * which measures how much of each fit window carried voice and scores a feature
 * down for exactly the reason it deserves.
 *
 * So the margin is not derived, it is swept, and more is not better:
 *
 *   margin   detection   invented bands   invented gain
 *   0.8         80%            5              9.6 dB
 *   1.5         83%            4              7.7 dB
 *   2.5         83%            9             22.9 dB
 *
 * 1.5 takes all the detection that widening buys. Going to the full span adds
 * nothing at the top, because Nyquist has already clamped it, while at the
 * bottom it extends the grid to 10 Hz — three octaves of spectrum a voice
 * cannot occupy — and features near the low boundary start being found against
 * fits made mostly of masked-out nothing.
 */
const ANALYSIS_MARGIN_OCTAVES = 1.5

/**
 * Confidence below which a feature is reported but not corrected.
 *
 * The line between "here is a fix" and "here is something you should look at".
 * A notch lands below it because its plausibility term collapses; a feature at
 * a bandwidth edge lands below it because its conditioning does. Both become
 * advisories through the same arithmetic rather than through two guards written
 * years apart.
 */
const MIN_CORRECTION_CONFIDENCE = 0.35

/** Corrections below this are inaudible and only clutter the findings list. */
const MIN_GAIN_DB = 0.5

/**
 * How far apart two corrections must sit, in octaves.
 *
 * Continuous detection finds everything, which is its point and also its
 * problem: on real material the residual has genuine fine structure, and
 * without this the detector emits neighbouring corrections that pull against
 * each other. On the reference clip that produced a -2.35 dB cut at 3466 Hz
 * next to a +1.71 dB boost at 3709 Hz — a tenth of an octave apart, opposite
 * signs, together doing almost nothing except making the findings list
 * unreadable. That is chasing ripple, not diagnosing.
 *
 * A third of an octave is roughly a critical band, so two corrections closer
 * than this are acting inside one region the ear hears as a single colour. If
 * both are needed, one broader filter is what was actually wanted; the stronger
 * of the two is the better approximation to it, and the weaker is dropped
 * rather than merged, because averaging two disagreeing measurements into a
 * band at neither frequency is how v1's merge step produced corrections that
 * sat on nothing.
 */
const MIN_SPACING_OCTAVES = 0.33

/**
 * Most corrections offered at once.
 *
 * A product limit, not a signal-processing one. Someone who cannot read a
 * spectrum can act on a short list of named problems; ten rows of +/-2 dB is
 * not a diagnosis, it is a spectrum in words. The strongest few are also the
 * ones that carry nearly all the audible change, so the tail costs little.
 */
const MAX_BANDS = 6

/**
 * How much of a feature's measured height to ask for.
 *
 * A resonance raises the trend it is measured against — the fit down-weights it
 * but cannot exclude it entirely — so the residual reads lower than the defect
 * really is and correcting the residual alone under-corrects. This compensates,
 * and unlike v1's per-region SCALE it is one number applied everywhere, so it
 * can be calibrated against the corpus rather than guessed per band.
 *
 * It is deliberately NOT paired with an iteration loop. v1 under-corrects by
 * 30% on purpose and then runs three passes to claw it back, which is two
 * mechanisms fighting and which turned a 3.6 dB measurement error on the
 * reference clip into a 7.9 dB correction. One measurement, one correction.
 */
const RECOVERY_GAIN = 1.25

/** Q from a half-height width in octaves, matching v1's formula. */
function qFromWidth(widthOctaves) {
  if (!(widthOctaves > 0)) return 3.0
  const q = 1 / (2 * Math.sinh((Math.LN2 / 2) * widthOctaves))
  return Math.min(8, Math.max(0.8, q))
}

function round(v, places) {
  const f = 10 ** places
  return Math.round(v * f) / f
}

/**
 * Analyse a mono selection.
 *
 * @param {Float32Array} audio
 * @param {number} sampleRate
 */
export function analyzeVoiceRxV2(audio, sampleRate) {
  const m = measure(audio, sampleRate)
  if (!m || m.ok === false) {
    return { ok: false, reason: m?.reason ?? 'no_voiced_frames', bands: [], advisories: [] }
  }

  // The grid runs WIDER than the range features are reported in. A trend fit
  // needs spectrum on both sides of a point to be a fit rather than an
  // extrapolation, and without the margin every feature near 60 Hz or 16 kHz is
  // measured against a one-sided window and scored down for it — which showed
  // up as planted defects at 180 and 300 Hz going undetected purely because of
  // where the grid happened to stop.
  const reportLoHz = REGION_SPAN_HZ[0]
  const reportHiHz = Math.min(REGION_SPAN_HZ[1], sampleRate / 2 - 1)
  const loHz = reportLoHz / Math.pow(2, ANALYSIS_MARGIN_OCTAVES)
  const hiHz = Math.min(sampleRate / 2 - 1, reportHiHz * Math.pow(2, ANALYSIS_MARGIN_OCTAVES))

  const grid = toLogGrid(m.freqsHz, m.envelopeDb, loHz, hiHz)
  const noiseGrid = m.noiseDb ? toLogGrid(m.freqsHz, m.noiseDb, loHz, hiHz) : null
  const { mask, snrDb, measured } = buildMask(grid.db, noiseGrid?.db, grid.n)

  const { trend } = robustTrend(grid.db, mask, grid.n)
  const residual = new Float64Array(grid.n)
  for (let i = 0; i < grid.n; i++) residual[i] = grid.db[i] - trend[i]

  // The halves get their own trends so each residual is measured against its
  // own reference — see halfAgreement.
  const halves = [m.firstHalfDb, m.secondHalfDb].map((db) => {
    if (!db) return null
    const g = toLogGrid(m.freqsHz, db, loHz, hiHz)
    const t = robustTrend(g.db, mask, g.n).trend
    const r = new Float64Array(g.n)
    for (let i = 0; i < g.n; i++) r[i] = g.db[i] - t[i]
    return r
  })

  const ctx = {
    n: grid.n,
    mask,
    voicedFrames: m.voicedFrames,
    firstResidual: halves[0],
    secondResidual: halves[1],
  }

  const { voiceType, regions } = classifyVoice(m.medianF0Hz)

  const features = findFeatures(grid.hz, residual, mask, grid.n)
    .filter(f => f.centreHz >= reportLoHz && f.centreHz <= reportHiHz)
    .map((f) => {
    const { confidence, terms } = scoreConfidence(f, ctx)
    const region = regionAtHz(regions, f.centreHz)
    return {
      ...f,
      confidence: round(confidence, 3),
      terms,
      region,
      roleId: roleForRegion(region)?.id ?? null,
    }
  })

  const candidates = []
  const flagged = []

  for (const f of features) {
    const sign = f.kind === 'resonance' ? -1 : 1
    const wanted = sign * f.heightDb * RECOVERY_GAIN * f.confidence
    const ceiling = wanted > 0 ? MAX_BOOST_DB : MAX_CORRECTION_DB
    const gainDb = Math.sign(wanted) * Math.min(Math.abs(wanted), ceiling)

    if (f.confidence < MIN_CORRECTION_CONFIDENCE || Math.abs(gainDb) < MIN_GAIN_DB) {
      // Only worth telling the user about if it is big enough to hear. A
      // low-confidence 2 dB wobble is not a finding, it is the reason the
      // threshold exists.
      if (f.heightDb >= 6) {
        flagged.push({
          id: `adv_${f.kind}_${Math.round(f.centreHz)}`,
          kind: f.kind,
          centreHz: round(f.centreHz, 1),
          depthDb: round(f.heightDb, 2),
          confidence: f.confidence,
          reason: dominantDoubt(f.terms),
          lowHz: round(f.lowHz, 1),
          highHz: round(f.highHz, 1),
        })
      }
      continue
    }

    candidates.push({
      region: f.region,
      roleId: f.roleId,
      freqHz: round(f.centreHz, 1),
      gainDb: round(gainDb, 2),
      q: round(qFromWidth(f.widthOctaves), 2),
      widthOctaves: round(f.widthOctaves, 3),
      confidence: f.confidence,
    })
  }

  // Strongest first, then greedily keep anything far enough from what has
  // already been kept. Greedy rather than exhaustive because the ranking is the
  // whole point: when two corrections compete for the same critical band, the
  // larger one is the one the listener would notice.
  const bands = []
  for (const c of candidates.sort((a, b) => Math.abs(b.gainDb) - Math.abs(a.gainDb))) {
    if (bands.length >= MAX_BANDS) break
    const crowded = bands.some(
      b => Math.abs(Math.log2(c.freqHz / b.freqHz)) < MIN_SPACING_OCTAVES,
    )
    if (!crowded) bands.push(c)
  }

  // Advisories get the same treatment, and need it for the same reason. One
  // wide notch has a floor that wanders, so the residual dips at more than one
  // grid point inside it — on the reference clip that reported the single
  // 5 kHz hole twice, at 5122 and 5537 Hz, which reads as two problems.
  const advisories = []
  for (const a of flagged.sort((x, y) => y.depthDb - x.depthDb)) {
    const crowded = advisories.some(
      b => Math.abs(Math.log2(a.centreHz / b.centreHz)) < MIN_SPACING_OCTAVES,
    )
    if (!crowded) advisories.push(a)
  }
  advisories.sort((a, b) => a.centreHz - b.centreHz)

  return {
    ok: true,
    voiceType,
    regions,
    medianF0Hz: round(m.medianF0Hz, 2),
    voicedFrames: m.voicedFrames,
    freqsHz: grid.hz,
    envelopeDb: grid.db,
    trendDb: trend,
    residualDb: residual,
    mask,
    snrDb,
    noiseFloorMeasured: measured,
    features,
    bands: bands.sort((a, b) => a.freqHz - b.freqHz),
    advisories,
    gridOctaves: GRID_OCTAVES,
  }
}

/** Which term dragged confidence down, so the advisory can say why. */
function dominantDoubt(terms) {
  return Object.entries(terms).sort((a, b) => a[1] - b[1])[0][0]
}
