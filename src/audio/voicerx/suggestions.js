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

import { createBand, getRole, roleForRegion } from '../eqBands.js'

/**
 * Plain-language symptom per region.
 *
 * Written as observations, not instructions — "this reads muddy" rather than
 * "cut 280 Hz". The user is being told what the tool heard; what to do about it
 * is the gain number next to it, and the decision is theirs.
 *
 * Deliberately avoids the vocabulary the control itself uses. A suggestion that
 * says "there is too much mud" next to a knob labelled Mud has told the user
 * nothing they could not already see.
 */
const SYMPTOMS = {
  sub_bass: 'Low-end rumble beneath the vocal range',
  body_warmth: 'The voice sounds thin, missing weight',
  mud: 'Sounds muddy — the low mids are crowded',
  boxy_honky: 'There is a boxy, hollow ring',
  nasal: 'The voice sounds pinched, like a blocked nose',
  lower_presence: 'The voice sits back — words are harder to pick out',
  upper_presence: 'This sounds harsh and overly present',
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
 * them from a role default. That is the difference between a labelled knob and
 * a diagnosis, and if the name promises a diagnosis the tool has to deliver
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
    }
  })
}

/**
 * Notes about the recording that are not corrections.
 *
 * A suggestion says "this region is wrong and here is the fix". An advisory
 * says "this part of the recording cannot be read, and here is why nothing was
 * offered for it" — which is a different sentence with a different ending, and
 * the reason it needs saying at all.
 *
 * WHY SILENCE IS THE WRONG ANSWER. Without this, a file with a notch in it
 * shows an emptier findings list than one without, and the emptier list reads
 * as the better diagnosis. The user hears an obvious problem around 5 kHz,
 * VoiceRx says nothing about it, and the tool looks like it missed the one
 * thing they could hear. Saying "there is a hole here and it is why Presence
 * and Sibilance were left alone" turns the same silence into a finding.
 *
 * WHY NO CORRECTION IS OFFERED — AND WHAT THAT IS NOT SAYING. A hole is a
 * deficiency and the arithmetic for filling one is trivial, so the reason to
 * decline has to be a real one.
 *
 * It is NOT that the band is empty. A notch is an attenuation, not a deletion,
 * and there is usually plenty of voice still under it: the clip this was built
 * against measures 23 dB of speech-above-floor at the bottom of a 17.6 dB hole.
 * That is the opposite of the brick-walled case DEAD_REGION_DB guards, where
 * the band really is numerical noise and a boost really does return nothing but
 * hiss. The two look alike on a plot and differ by 40 dB of SNR; do not reason
 * from one to the other.
 *
 * The real reasons are these. Filling a hole this deep takes a boost larger
 * than any correction VoiceRx will make on its own, and MAX_TOTAL_CAP_FACTOR
 * has already settled what to do with a measurement that size — flag it, do not
 * spend it, because past about 14 dB the measurement is as likely to be wrong
 * as the voice is to be that broken. The band's room tone comes up with the
 * boost, and a notched voice does not imply a notched floor to compensate: on
 * that same clip the noise floor inside the hole is 8 dB HIGHER than an octave
 * below it, so the lift is paid for in full. And the tool cannot know why the
 * hole is there. Someone may have cut a resonance, a whistle or a mic artefact
 * deliberately, and undoing that unasked restores the problem they removed.
 *
 * So report it, name what it cost, and leave the decision — which is about the
 * recording's history, not about its spectrum — to the person who has it.
 *
 * @param {object} analysis result of analyzeVoiceRx
 * @returns {Array<{id:string, title:string, detail:string, lowHz:number, highHz:number}>}
 */
export function buildAdvisories(analysis) {
  if (!analysis?.ok || !analysis.holes?.length) return []

  return analysis.holes.map((hole, i) => {
    // Which corrections this hole cost the user. Named by their role labels,
    // because that is what the user sees on the control surface — telling
    // someone that "upper_presence was suppressed" names a thing they have
    // never been shown.
    const suppressed = (analysis.regionResults ?? [])
      .filter(r =>
        r.skipReason === 'spectral_hole' &&
        r.scanLowHz < hole.highHz && r.scanHighHz > hole.lowHz,
      )
      .map(r => getRole(roleForRegion(r.name)?.id)?.label)
      .filter(Boolean)

    const where = formatHz(hole.centerHz)
    const depthDb = Math.round(hole.depthDb)
    const depth = `${depthDb} dB`
    const article = articleFor(depthDb)

    // Careful with this wording. The band is quiet, not empty — there is still
    // voice under a notch — so anything implying the frequencies are gone for
    // good is both false and the wrong reason to leave them alone.
    let detail = `Something has already taken these frequencies out — an EQ cut, `
      + `or the device this was recorded on. VoiceRx has not put them back on `
      + `its own: that would take ${article} ${depth} boost, far bigger than any move it `
      + `makes unasked, and the room tone in this band comes up with it.`

    if (suppressed.length) {
      detail += ` ${listOf(suppressed)} ${suppressed.length > 1 ? 'sit' : 'sits'} `
        + `across it and cannot be measured honestly while it is there, so `
        + `${suppressed.length > 1 ? 'they have' : 'it has'} been left alone.`
    }

    detail += ` If you know why it is there — and that it should not be — you `
      + `can lift it by hand in the EQ.`

    return {
      id: `adv_hole_${i}`,
      title: `${article === 'an' ? 'An' : 'A'} ${depth} notch at ${where}`,
      detail,
      lowHz: hole.lowHz,
      highHz: hole.highHz,
    }
  })
}

/**
 * "a" or "an" for a number the user will read aloud in their head.
 *
 * Driven by how the digits SOUND, not how they are spelled: 18 is "eighteen"
 * and takes "an", 40 is "forty" and takes "a". Only 8, 11 and 18 fall on the
 * vowel side within the range a hole depth can occupy, which is bounded below
 * by MIN_DEPTH_DB and in practice never reaches three digits.
 */
function articleFor(n) {
  return [8, 11, 18].includes(n) ? 'an' : 'a'
}

/** "A", "A and B", "A, B and C" — the list reads as a sentence, not as data. */
function listOf(names) {
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Turn a suggestion into a band.
 *
 * The band is tagged with the suggestion's role and carries the MEASURED Q, not
 * the role's canonical one — so `qModified` comes out true. That is correct and
 * intended: double-clicking the role's width knob resets to the canonical width
 * if the measured one turns out wrong, which is a judgement only the user's ear
 * can make.
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
