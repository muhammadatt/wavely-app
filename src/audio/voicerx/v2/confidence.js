/**
 * VoiceRx v2 — how much to believe each feature.
 *
 * THIS IS THE PIECE v1 HAS NO EQUIVALENT OF, and most of its worst behaviour
 * traces back to that. v1 decides yes or no against a fixed threshold and then,
 * faced with an implausibly large measurement, CAPS it — so a 26 dB deviation
 * measured against an anchor sitting in a notch came out as a cut pinned at
 * exactly twice the per-pass limit. Capping is the wrong response to a
 * measurement you do not believe. Disbelieving it is the right one.
 *
 * Every guard v1 accumulated is a confidence signal that was hard-coded as a
 * special case instead: DEAD_REGION_DB and `no_energy` are "there is no data
 * here", `flatBaseline` is "the fit is one-sided", `spectral_hole` is "the
 * reference is contaminated", MIN_VOICED_FRAMES is "not enough evidence". Four
 * mechanisms, four sets of constants, and the corpus shows their coverage is
 * patchy in ways nobody chose — a notch at 5 kHz is caught and the same notch
 * at 800 Hz is not.
 *
 * Here they are four terms in one number, multiplied. Multiplied rather than
 * averaged because they are independent reasons to doubt and any one of them
 * being near zero should be decisive: a feature measured from forty frames
 * against a half-masked window is not two-thirds believable.
 */

import { GRID_OCTAVES, SPAN_OCTAVES } from './trend.js'

/**
 * Frames at which evidence stops being the limiting factor.
 *
 * Below this, confidence falls off as the square root of the count — the
 * standard error of a mean, which is what the envelope is. Above it, adding
 * frames stops telling you anything new about a stationary spectrum.
 */
const AMPLE_FRAMES = 150

/**
 * Height beyond which a measurement is more likely to be wrong than the voice
 * is to be that broken.
 *
 * Not a cap. Confidence decays smoothly past it, so a 20 dB feature is reported
 * with a small correction and a loud advisory rather than with a 20 dB cut or a
 * silent clamp at 8. v1's MAX_TOTAL_CAP_FACTOR comment reaches this exact
 * conclusion — "a 15 dB surgical cut taken on trust is the worse mistake" — and
 * then implements a clamp, which spends the maximum instead of the minimum on
 * precisely the measurements it distrusts most.
 */
const IMPLAUSIBLE_DB = 12

/**
 * The same threshold for a deficiency, which is lower — deliberately.
 *
 * Correcting a deficiency means BOOSTING, and a boost is not the mirror image
 * of a cut. It lifts the room tone and hiss in that band by the full amount,
 * while a cut lowers them; the risk is genuinely one-sided, so the willingness
 * to spend should be too. v1 encodes the same asymmetry in its region tables
 * (boost caps of 3-4 dB against cut caps of 4-6) without ever saying why.
 *
 * The value is not free either — it is MAX_BOOST_DB over RECOVERY_GAIN, the
 * residual height at which the requested boost would start being clipped by the
 * ceiling anyway. Coupling them means confidence begins to decay exactly where
 * the policy has already decided not to spend more, instead of the two
 * disagreeing about where "too big" starts.
 *
 * It lands where the corpus needs it. Measured residuals: a shallow correctable
 * dip reads 3.1 dB, a -15 dB notch reads 5.8 and a -20 dB notch 8.1 — a notch
 * wide enough to matter is partly followed by the trend measuring it, so true
 * depth and residual depth are not the same number. Four sits below the notches
 * and above the dip, so the dip is filled and the notches decay into advisories
 * rather than drawing a boost into a band whose noise floor would rise with it.
 */
const IMPLAUSIBLE_DEFICIENCY_DB = 4

/**
 * How closely the two halves of the selection must agree.
 *
 * THE STRONGEST SIGNAL HERE, and the one with no counterpart anywhere in v1. A
 * resonance is a property of the room, the microphone or the voice, so it is
 * present in the first half of a passage and in the second. A measurement
 * artefact — a baseline tipped by something local, a feature riding on one loud
 * phrase — usually is not. Splitting the frames and asking whether the feature
 * survives independently is nearly free, because both half-envelopes are
 * accumulated in the same pass as the full one.
 *
 * The tolerance is in dB of disagreement, and it is generous: half as many
 * frames is a noisier envelope, so some spread is expected even for a feature
 * that is entirely real.
 */
const STABILITY_TOLERANCE_DB = 4

/**
 * Score one feature in [0, 1].
 *
 * @param {object} feature from findFeatures
 * @param {object} ctx grid, residuals, mask, support and frame counts
 */
export function scoreConfidence(feature, ctx) {
  const evidence = Math.min(1, Math.sqrt(ctx.voicedFrames / AMPLE_FRAMES))

  // How much real spectrum the trend had to work with around this feature. A
  // fit whose window ran off the end of the band, or into a hole, is a weaker
  // statement about what the level "should" be here — which is exactly the
  // situation that produced v1's phantom cuts either side of a notch and at
  // bandwidth edges.
  const conditioning = maskCoverage(ctx.mask, ctx.n, feature.index)

  // Does the feature survive being measured on half the data, twice?
  const stability = halfAgreement(feature, ctx)

  const limit = feature.kind === 'deficiency' ? IMPLAUSIBLE_DEFICIENCY_DB : IMPLAUSIBLE_DB
  const plausibility = feature.heightDb <= limit
    ? 1
    : Math.max(0, 1 - (feature.heightDb - limit) / limit)

  return {
    confidence: clamp01(evidence * conditioning * stability * plausibility),
    terms: {
      evidence: round(evidence),
      conditioning: round(conditioning),
      stability: round(stability),
      plausibility: round(plausibility),
    },
  }
}

/**
 * Fraction of the trend's fit window around this point that carried voice.
 *
 * Weighted toward the centre, matching the tricube the fit itself uses — a
 * masked patch at the very edge of a 1.5-octave window barely affects the
 * estimate, and counting it equally would penalise a perfectly good fit.
 */
function maskCoverage(mask, n, index) {
  const w = Math.round(SPAN_OCTAVES / GRID_OCTAVES)
  let total = 0
  let live = 0
  for (let j = index - w; j <= index + w; j++) {
    const u = Math.abs(j - index) / (w + 1)
    const weight = (1 - Math.min(1, u) ** 3) ** 3
    total += weight
    if (j >= 0 && j < n && mask[j]) live += weight
  }
  return total > 0 ? live / total : 0
}

/**
 * Agreement between the feature's height in each half of the selection.
 *
 * Measured against each half's own trend, not against the full-selection trend.
 * Half the frames gives a slightly different envelope and therefore a slightly
 * different reference, and comparing a half-envelope to the full trend would
 * score that difference as instability when it is just arithmetic.
 */
function halfAgreement(feature, ctx) {
  if (!ctx.firstResidual || !ctx.secondResidual) return 1

  const i = feature.index
  const sign = feature.kind === 'resonance' ? 1 : -1
  // Allow the peak to land a grid point or two away in each half; the question
  // is whether the feature is there, not whether it is at the same bin.
  const slack = 2
  const heightIn = (residual) => {
    let best = -Infinity
    for (let j = Math.max(0, i - slack); j <= Math.min(ctx.n - 1, i + slack); j++) {
      best = Math.max(best, sign * residual[j])
    }
    return best
  }

  const a = heightIn(ctx.firstResidual)
  const b = heightIn(ctx.secondResidual)

  // A feature that reverses sign in one half is not a quiet disagreement, it is
  // evidence the thing is not there at all.
  if (a <= 0 || b <= 0) return 0

  const disagreement = Math.abs(a - b)
  return clamp01(1 - disagreement / STABILITY_TOLERANCE_DB)
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function round(v) {
  return Math.round(v * 1000) / 1000
}
