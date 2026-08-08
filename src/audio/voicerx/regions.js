/**
 * VoiceRx detection regions — the client half of Stage 3a's region tables.
 *
 * Direct port of MALE_REGIONS / FEMALE_REGIONS / classify_voice in
 * server/scripts/corrective_eq.py:64-108. Keep the numbers in sync with that
 * file; they are the calibrated ones, and this module deliberately holds no
 * opinions of its own about them.
 *
 * WHY THE RANGES MOVE. A region is a *place a problem lives*, and where that is
 * depends on the voice. Mud sits at 200-420 Hz for a male narrator and
 * 280-550 Hz for a female one, because it is a fixed interval above the
 * fundamental rather than a fixed frequency. This is the whole reason VoiceRx
 * classifies voice type: not to pick a reference curve (there is none — the
 * baseline is derived from the file itself), but to aim the scan ranges.
 *
 * WHY DIRECTION IS NOT THE SAME AS SLIDER BIAS. `direction` says which way this
 * region is *scanned* — a hump region looks for an excess and can only ever
 * suggest a cut. It says nothing about which way the user may then drag the
 * control. The manual EQ is unclamped in both directions for every role; see
 * the manual EQ spec §2.2 and §5.1, where `presence` is explicitly bidirectional
 * with a sign-dependent label even though Stage 3a only scans it for humps.
 *
 * Dependency-free — no Web Audio, no DOM. Imported by the analysis module and
 * by the band model, and unit-tested directly.
 */

/** Region order, low frequency to high. Drives display and band ordering. */
export const REGION_ORDER = [
  'sub_bass', 'body_warmth', 'mud', 'boxy_honky', 'nasal',
  'lower_presence', 'upper_presence', 'brilliance', 'air',
]

/**
 * Each entry: [scanLowHz, scanHighHz, direction, thresholdDb, maxBoostDb, maxCutDb, scale]
 *
 * `maxBoostDb` / `maxCutDb` use 0 for the direction the region cannot correct —
 * a hump produces only cuts, a dip only boosts. `_combine` in the merge step
 * treats those zeros as "no limit contributed" rather than "clamp to zero".
 */
export const MALE_REGIONS = {
  sub_bass:       [60,   130,   'hump', 4.0, 0.0, 4.0, 0.70],
  body_warmth:    [120,  280,   'dip',  3.0, 4.0, 0.0, 0.70],
  mud:            [200,  420,   'hump', 2.5, 0.0, 6.0, 0.70],
  boxy_honky:     [380,  700,   'hump', 2.5, 0.0, 5.0, 0.70],
  nasal:          [650,  1200,  'hump', 2.5, 0.0, 5.0, 0.70],
  lower_presence: [1200, 2500,  'dip',  3.0, 4.0, 0.0, 0.70],
  upper_presence: [2500, 5000,  'hump', 2.5, 0.0, 5.0, 0.60],
  brilliance:     [5000, 9000,  'hump', 3.0, 0.0, 4.0, 0.70],
  air:            [9000, 16000, 'dip',  3.5, 3.0, 0.0, 0.70],
}

export const FEMALE_REGIONS = {
  sub_bass:       [60,   130,   'hump', 4.0, 0.0, 4.0, 0.70],
  body_warmth:    [180,  350,   'dip',  3.0, 4.0, 0.0, 0.70],
  mud:            [280,  550,   'hump', 2.5, 0.0, 6.0, 0.70],
  boxy_honky:     [450,  800,   'hump', 2.5, 0.0, 5.0, 0.70],
  nasal:          [750,  1400,  'hump', 2.5, 0.0, 5.0, 0.70],
  lower_presence: [1500, 3000,  'dip',  3.0, 4.0, 0.0, 0.70],
  upper_presence: [3000, 6000,  'hump', 2.5, 0.0, 5.0, 0.60],
  brilliance:     [5000, 9000,  'hump', 3.0, 0.0, 4.0, 0.70],
  air:            [9000, 16000, 'dip',  3.5, 3.0, 0.0, 0.70],
}

/** Field order within a region tuple, for readable destructuring. */
export const SCAN_LOW = 0
export const SCAN_HIGH = 1

export const DIRECTION = 2
export const THRESHOLD_DB = 3
export const MAX_BOOST_DB = 4
export const MAX_CUT_DB = 5
export const SCALE = 6

/**
 * Which region a frequency belongs to.
 *
 * Needed because a click on the plot has to name a role, and the tables do not
 * partition the spectrum cleanly enough to just test containment. Neighbours
 * overlap by design — a male voice shares 200-280 Hz between body_warmth and
 * mud, a female one shares a full kilohertz between upper_presence and
 * brilliance — and the female table has two outright gaps, 130-180 Hz and
 * 1400-1500 Hz, where a strict test would find nothing at all.
 *
 * So the answer is the nearest region rather than the containing one, measured
 * in half-widths of log-frequency from each region's centre. Inside a region
 * that distance is under 1; in an overlap the region the point sits more
 * centrally within wins; in a gap the closer neighbour takes it instead of the
 * click being swallowed. Normalising by half-width is what makes a narrow
 * region and a wide one compete fairly.
 */
export function regionAtHz(table, hz) {
  if (!table || !Number.isFinite(hz) || hz <= 0) return null
  const target = Math.log2(hz)

  let best = null
  let bestDistance = Infinity
  for (const [name, span] of Object.entries(table)) {
    const lo = Math.log2(span[SCAN_LOW])
    const hi = Math.log2(span[SCAN_HIGH])
    const halfWidth = (hi - lo) / 2
    if (!(halfWidth > 0)) continue
    const distance = Math.abs(target - (lo + hi) / 2) / halfWidth
    if (distance < bestDistance) {
      bestDistance = distance
      best = name
    }
  }
  return best
}

/**
 * The whole span the regions cover, low to high.
 *
 * Derived from both tables rather than written down, so it cannot fall out of
 * step with them. It is the outer edge of everything VoiceRx measures or offers
 * a control for, which makes it the right frequency axis for VoiceRx's display:
 * beyond it there is nothing to draw, nothing to detect and no role to adjust.
 *
 * The two tables happen to agree at both ends today — sub_bass starts at 60 Hz
 * and air ends at 16 kHz for either voice — so this is a constant in practice.
 * Computing it keeps that a fact about the data rather than an assumption.
 */
export const REGION_SPAN_HZ = [MALE_REGIONS, FEMALE_REGIONS].reduce(
  ([lo, hi], table) => Object.values(table).reduce(
    ([a, b], region) => [Math.min(a, region[SCAN_LOW]), Math.max(b, region[SCAN_HIGH])],
    [lo, hi],
  ),
  [Infinity, -Infinity],
)

const MALE_MAX_F0 = 165.0
const FEMALE_MIN_F0 = 200.0

/**
 * Resolve the region table for a measured median F0.
 *
 * Between the two thresholds the scan boundaries are linearly interpolated and
 * rounded to the nearest 10 Hz; every other field is identical across the two
 * tables, so only the boundaries move. Returns `ambiguous` there rather than
 * forcing a side, because the display says so and a narrator whose pitch sits
 * in that band deserves to know the ranges are a blend.
 *
 * @param {number} medianF0Hz
 * @returns {{ voiceType: 'male'|'female'|'ambiguous', regions: object }}
 */
export function classifyVoice(medianF0Hz) {
  if (!Number.isFinite(medianF0Hz) || medianF0Hz <= 0) {
    // No pitched material to classify from. Male is the safer default for
    // narration, and the caller surfaces the failure separately.
    return { voiceType: 'male', regions: MALE_REGIONS }
  }
  if (medianF0Hz < MALE_MAX_F0) return { voiceType: 'male', regions: MALE_REGIONS }
  if (medianF0Hz > FEMALE_MIN_F0) return { voiceType: 'female', regions: FEMALE_REGIONS }

  const t = (medianF0Hz - MALE_MAX_F0) / (FEMALE_MIN_F0 - MALE_MAX_F0)
  const regions = {}
  for (const name of REGION_ORDER) {
    const m = MALE_REGIONS[name]
    const f = FEMALE_REGIONS[name]
    regions[name] = [
      Math.round((m[SCAN_LOW] * (1 - t) + f[SCAN_LOW] * t) / 10) * 10,
      Math.round((m[SCAN_HIGH] * (1 - t) + f[SCAN_HIGH] * t) / 10) * 10,
      m[DIRECTION], m[THRESHOLD_DB], m[MAX_BOOST_DB], m[MAX_CUT_DB], m[SCALE],
    ]
  }
  return { voiceType: 'ambiguous', regions }
}
