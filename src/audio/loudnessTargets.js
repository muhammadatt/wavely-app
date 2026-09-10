/**
 * Commercial loudness benchmarks — the delivery specs the Loudness window's
 * buttons stand for.
 *
 * ── WHAT A TARGET IS, AND WHAT IT IS NOT ────────────────────────────────────
 * Three numbers and a measurement method: a loudness target, a peak ceiling,
 * and which meter the target is stated on. That is the whole of a delivery
 * spec as far as normalization is concerned, and it is deliberately all this
 * file knows — a target does not carry EQ, compression or any character. This
 * is the "put it at the level the platform asks for" tool; the preset chain
 * under Master is the "make it sound like that platform's programming" one.
 *
 * ── ACX IS THE ODD ONE, AND IT IS THE ONE THAT MATTERS MOST HERE ────────────
 * Every streaming target below is stated in K-weighted, gated LUFS with a
 * true-peak ceiling. ACX is stated in UNGATED, UNWEIGHTED RMS with a sample-
 * peak ceiling, and audits submissions with exactly that measurement. Reading
 * one with the other's meter is several dB out on real narration, which is why
 * `unit` rides on every entry and reaches the measurement rather than being
 * assumed. See `measuredFor` / `peakFor` in dsp/loudnessNormalize.js.
 *
 * ── PLATFORM NUMBERS DRIFT, AND THAT IS WHY THEY ARE DATA ───────────────────
 * These are the published figures as of this file's date. Streaming services
 * revise them; each entry carries a `note` naming what it is so a stale one is
 * legible rather than mysterious. `test/dsp/loudnessTargets.test.js` pins the
 * three that also exist as server output profiles (acx, podcast, broadcast) to
 * `OUTPUT_PROFILES` in presets.js, so the client's spot normalizer and the
 * server's mastering chain cannot come to disagree about what ACX wants.
 */

/**
 * @typedef {Object} LoudnessTarget
 * @property {string} id
 * @property {string} label      Printed on the button — short, it is a chip
 * @property {string} name       Full name, for the readout line
 * @property {string} group      Which band of buttons it sits in
 * @property {number} targetDb   Loudness target, in the entry's own unit
 * @property {'LUFS'|'RMS'} unit Which meter the target is stated on
 * @property {number} ceilingDb  Peak ceiling — dBTP for LUFS, dBFS for RMS
 * @property {string} note       One line: what this number is
 */

/** The section headings, in the order the panel draws them. */
export const TARGET_GROUPS = [
  { id: 'spoken', label: 'SPOKEN WORD' },
  { id: 'streaming', label: 'MUSIC & VIDEO' },
]

/** @type {LoudnessTarget[]} */
export const LOUDNESS_TARGETS = [
  {
    id: 'acx',
    label: 'ACX',
    name: 'ACX Audiobook',
    group: 'spoken',
    targetDb: -20,
    unit: 'RMS',
    ceilingDb: -3,
    note: 'ACX accepts -23 to -18 dBFS RMS; -20 is the middle of it',
  },
  {
    id: 'podcast',
    label: 'PODCAST',
    name: 'Podcast / Streaming',
    group: 'spoken',
    targetDb: -16,
    unit: 'LUFS',
    ceilingDb: -1,
    note: 'The mono-podcast norm Apple Podcasts and Spotify both play back at',
  },
  {
    id: 'broadcast',
    label: 'EBU R128',
    name: 'Broadcast (EBU R128)',
    group: 'spoken',
    targetDb: -23,
    unit: 'LUFS',
    ceilingDb: -1,
    note: 'The European broadcast standard, and ATSC A/85 within 1 LU',
  },
  {
    id: 'spotify',
    label: 'SPOTIFY',
    name: 'Spotify',
    group: 'streaming',
    targetDb: -14,
    unit: 'LUFS',
    ceilingDb: -1,
    note: 'Spotify normalizes playback to -14 LUFS and asks for -1 dBTP',
  },
  {
    id: 'apple',
    label: 'APPLE',
    name: 'Apple Music',
    group: 'streaming',
    targetDb: -16,
    unit: 'LUFS',
    ceilingDb: -1,
    note: 'Sound Check plays back at -16 LUFS',
  },
  {
    id: 'youtube',
    label: 'YOUTUBE',
    name: 'YouTube',
    group: 'streaming',
    targetDb: -14,
    unit: 'LUFS',
    ceilingDb: -1,
    note: 'YouTube turns anything louder than -14 LUFS down on playback',
  },
  {
    id: 'amazon-music',
    label: 'AMAZON',
    name: 'Amazon Music',
    group: 'streaming',
    targetDb: -14,
    unit: 'LUFS',
    ceilingDb: -2,
    note: 'Amazon Music asks for -2 dBTP, a dB tighter than the others',
  },
  {
    id: 'tidal',
    label: 'TIDAL',
    name: 'Tidal',
    group: 'streaming',
    targetDb: -14,
    unit: 'LUFS',
    ceilingDb: -1,
    note: 'Tidal normalizes playback to -14 LUFS',
  },
]

/** Where a freshly-opened panel lands. */
export const DEFAULT_TARGET_ID = 'podcast'

export function targetById(id) {
  return LOUDNESS_TARGETS.find(t => t.id === id) ?? null
}

/** Targets in one group, in table order. */
export function targetsInGroup(groupId) {
  return LOUDNESS_TARGETS.filter(t => t.group === groupId)
}

/**
 * How close a hand-set value has to be to a benchmark for its button to light.
 *
 * ⚠ THE BUTTONS DESCRIBE VALUES, THEY ARE NOT A MODE. Turning the Target knob
 * onto -14.0 LUFS with a -1 dBTP ceiling IS the Spotify setting, and lighting
 * the button then is the truth — the alternative is a panel that is set to
 * Spotify's numbers while claiming it is not. The same reasoning as the soft
 * clipper's ceiling setters.
 */
export const TARGET_MATCH_DB = 0.05

/**
 * Every benchmark the current settings sit on — a LIST, because more than one
 * of them can be true at once.
 *
 * ⚠ SEVERAL OF THESE SPECS ARE THE SAME THREE NUMBERS, and that is not a
 * duplicate entry to be cleaned up. Apple Music's -16 LUFS / -1 dBTP is the
 * podcast norm's -16 LUFS / -1 dBTP; Spotify, YouTube and Tidal all sit on -14
 * LUFS / -1 dBTP. A user aiming at one of them is aiming at all of them, and a
 * panel that lit only the first in the table would be telling a podcaster they
 * had set Apple Music. So the value lights every button it satisfies, and the
 * panel keeps the one that was clicked only to decide which note to print.
 */
export function matchingTargets(targetDb, unit, ceilingDb) {
  return LOUDNESS_TARGETS.filter(t =>
    t.unit === unit
    && Math.abs(t.targetDb - targetDb) <= TARGET_MATCH_DB
    && Math.abs(t.ceilingDb - ceilingDb) <= TARGET_MATCH_DB
  )
}

/** The first benchmark the current settings sit on, or null. */
export function matchTarget(targetDb, unit, ceilingDb) {
  return matchingTargets(targetDb, unit, ceilingDb)[0] ?? null
}
