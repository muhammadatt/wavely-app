/**
 * Scheduling stimulus events around a demo plugin's periodic mute.
 *
 * ⚠ THIS IS REFERENCE-AGNOSTIC BY ACCIDENT OF ARITHMETIC, NOT BY MEASUREMENT.
 * The grid below was measured on Waves demo plugins (see the constants), and it
 * is the only mute grid anyone here has characterised. A reference that mutes on
 * a DIFFERENT period is not protected by this module — `preflight` in
 * `probeCapture.js` is what catches that, by reporting where the silences
 * actually fell. Scheduling around a mute that is not there costs only a longer
 * rest between events, so an un-muted reference (Analog Obsession's plugins are
 * free and do not mute) can use the same stimulus without penalty. That is the
 * reason to schedule unconditionally rather than behind a flag: one stimulus
 * file serves both references, and two references measured on two different
 * stimuli cannot be compared.
 *
 * THE GRID, and why it is schedulable rather than random damage. Measured
 * across NINE captures from three sessions at five knob settings, with file
 * lengths from 98 s to 162 s, the pattern is identical every time: first mute
 * at 20.01 s, then every 20.00 s, lasting 0.99 s. The edges are sharp — last
 * clean sample 19.99 s, dead by 20.01, dead until 20.99, clean again at
 * 21.01 — so a 0.1 s guard on each side is generous.
 *
 * ⚠ THE GRID IS RELATIVE TO THE RENDER'S START, NOT THE FILE'S. A bounce with
 * pre-roll slides every event into the mutes it was placed to avoid, and the
 * only symptom is events going missing. `preflight` measures that offset
 * directly and says re-render.
 *
 * WHAT IT COST BEFORE IT EXISTED: the CLA-2A frequency plan lost BOTH its
 * 400 Hz and 3 kHz probes — exactly the pair that would settle whether the
 * side-chain carries a real HF emphasis — and the retrigger plan lost two of
 * its five gaps.
 */

export const MUTE_PERIOD_S = 20.0
export const MUTE_LEN_S = 1.0
export const MUTE_GUARD_S = 0.1

/** The longest protected span that can fit between two mutes. */
export const CLEAN_WINDOW_S = MUTE_PERIOD_S - MUTE_LEN_S - 2 * MUTE_GUARD_S

/**
 * Earliest start >= `t` at which a protected span of `span` seconds is clear.
 *
 * ⚠ THE SHIFT MUST BE TAKEN OUT OF THE REST BETWEEN EVENTS AND NEVER FROM
 * INSIDE ONE. Callers pass the whole measured group as one span — a
 * conditioning burst, its gap and its test step travel together — because the
 * gap IS the measurement. The rest only ever gets longer, so nothing measured
 * moves.
 *
 * ⚠ THE INFEASIBLE CASE THROWS RATHER THAN SEARCHING, AND IT HAS TO. Pushing
 * past a mute is only progress if the span then fits before the NEXT one; for a
 * span longer than the window every push lands on another mute, and the search
 * chases `t` forever. Caught by testing it — a 12 s burst hung the stimulus
 * build instead of failing it.
 */
export function scheduleClear(t, span, tag = 'event') {
  if (span > CLEAN_WINDOW_S) {
    throw new Error(
      `${tag}: protected span ${span.toFixed(2)}s exceeds the ${CLEAN_WINDOW_S.toFixed(2)}s ` +
      'clean window between demo mutes, so no placement can avoid one. Shorten the ' +
      'event, PRE_S or POST_S — or drop the mute scheduling and accept losing it.')
  }
  for (let k = 1; k * MUTE_PERIOD_S < t + span + MUTE_PERIOD_S; k++) {
    const from = k * MUTE_PERIOD_S - MUTE_GUARD_S
    const to = k * MUTE_PERIOD_S + MUTE_LEN_S + MUTE_GUARD_S
    if (from >= t + span) break
    if (to > t) t = to
  }
  return t
}

/**
 * ⚠ A STIMULUS THAT LOSES AN EVENT MUST NOT BUILD. This is the guard on the
 * slack left by `scheduleClear`: it re-derives each protected span from the
 * events themselves, so it catches an overflow introduced by editing the
 * constants rather than trusting the scheduler that just ran.
 *
 * @param {string} name           - plan name, for the message
 * @param {Array<[string, number, number]>} spans - [tag, fromSec, toSec]
 */
export function assertPlanClear(name, spans) {
  for (const [tag, from, to] of spans) {
    for (let k = 1; k * MUTE_PERIOD_S < to + MUTE_PERIOD_S; k++) {
      const mFrom = k * MUTE_PERIOD_S - MUTE_GUARD_S
      const mTo = k * MUTE_PERIOD_S + MUTE_LEN_S + MUTE_GUARD_S
      if (mFrom < to && mTo > from) {
        throw new Error(
          `${name}: "${tag}" spans ${from.toFixed(2)}-${to.toFixed(2)}s and hits the ` +
          `demo mute at ${(k * MUTE_PERIOD_S).toFixed(2)}s. The protected span is ` +
          `${(to - from).toFixed(2)}s against a ${CLEAN_WINDOW_S.toFixed(2)}s clean window — ` +
          'shorten it, or the capture loses this event.')
      }
    }
  }
}
