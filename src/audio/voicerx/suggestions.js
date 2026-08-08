/**
 * VoiceRx suggestions — turning detections into something a non-professional can
 * act on.
 *
 * VoiceRx corrects on arrival: analyze -> hear it fixed -> adjust. Analysis
 * turns every suggestion into an enabled band itself (see
 * useVoiceRx.applyAllSuggestions), so the first thing the user hears is the
 * corrected version rather than a panel describing problems the audio still
 * has. Review comes after, not before — each row stays switchable, which is why
 * a suggestion remains addressable long past the moment it was applied.
 *
 * SUGGESTIONS ARE VIEW STATE, NOT BAND STATE (spec §9.2). They live outside the
 * band pool entirely, derived from the frozen analysis on every read. Nothing
 * to migrate, nothing to reconcile with role tags, no partial-application
 * states — and handing the bands off to the EQ leaves the analysis untouched,
 * so the suggestions simply come back, ready to be re-applied by their row.
 *
 * DETECTION ALWAYS RUNS ON THE DRY SIGNAL (spec §9.1). Once suggestions are
 * applied the composite curve flattens; detection re-run on the post-EQ signal
 * would either find nothing or suggest the inverse — a feedback loop. This is
 * structurally the same failure mode as EMA contamination in the sibilance
 * detector: the reference must be computed from a source the correction cannot
 * touch. Nothing in this module reads the band pool.
 */

import { createBand, getRole } from '../eqBands.js'

/**
 * Plain-language symptom per region.
 *
 * Written as observations, not instructions — "this reads muddy" rather than
 * "cut 280 Hz". The user is being told what the tool heard; what to do about it
 * is the gain number next to it, and the decision is theirs.
 *
 * Deliberately avoids the vocabulary the control itself uses. A suggestion that
 * says "there is too much mud" next to a slider labelled Mud has told the user
 * nothing they could not already see.
 */
const SYMPTOMS = {
  sub_bass: 'Low-end rumble is sitting under the voice',
  body_warmth: 'The voice sounds thin — it is missing weight',
  mud: 'Sounds muddy — the low mids are crowded',
  boxy_honky: 'There is a boxy, hollow ring to this',
  nasal: 'The voice sounds pinched, like a blocked nose',
  lower_presence: 'Speech sits back — words are harder to pick out',
  upper_presence: 'This sounds harsh and forward in the ear',
  brilliance: 'The S sounds are sharp',
  air: 'The top end is dull and lacking air around the voice',
}

/** Where a merged band's symptom comes from: the lower-frequency contributor. */
function symptomFor(region) {
  const primary = region.split('+')[0]
  return SYMPTOMS[primary] ?? 'this region reads uneven'
}

function formatHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`
}

/**
 * Build the suggestion list from an analysis result.
 *
 * One suggestion per merged band. Each carries the measured centre frequency,
 * the measured Q and the computed gain — all three from the detection, none of
 * them from a role default. That is the difference between a labelled slider
 * and a diagnosis, and if the name promises a diagnosis the tool has to deliver
 * one.
 *
 * @param {object} analysis result of analyzeVoiceRx
 * @returns {Array<object>} suggestions, low frequency to high
 */
export function buildSuggestions(analysis) {
  if (!analysis?.ok) return []

  return analysis.bands.map((band, i) => {
    const role = band.roleId ? getRole(band.roleId) : null
    return {
      id: `sug_${i}_${band.region}`,
      region: band.region,
      roleId: band.roleId,
      roleLabel: role?.label ?? 'Band',
      frequencyHz: band.freqHz,
      gainDb: band.gainDb,
      q: band.q,
      symptom: `${symptomFor(band.region)}, around ${formatHz(band.freqHz)}`,
      // "less harsh" vs "more presence" — the sign-dependent label from §5.1,
      // resolved here so the row and the slider always agree on the wording.
      effect: role ? role.describe(band.gainDb) : 'correction',
    }
  })
}

/**
 * Turn a suggestion into a band.
 *
 * The band is tagged with the suggestion's role and carries the MEASURED Q, not
 * the role's canonical one — so `qModified` comes out true and VoiceRx shows the
 * "modified" marker with its reset affordance. That is correct and intended:
 * the reset is there to get back to the canonical width if the measured one
 * turns out wrong, which is a judgement only the user's ear can make.
 *
 * @param {object} suggestion
 * @param {object} regions resolved region table from the same analysis
 */
export function suggestionToBand(suggestion, regions) {
  return createBand({
    role: suggestion.roleId,
    regions,
    frequencyHz: suggestion.frequencyHz,
    gainDb: suggestion.gainDb,
    q: suggestion.q,
    origin: 'suggestion',
  })
}
