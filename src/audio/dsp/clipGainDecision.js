/**
 * Clip-gain de-esser: the per-event gain decision.
 *
 * Port of the decision half of server/scripts/clip_gain_deesser.py. The Python
 * does this inline in its render loop; here it is separate, because it is the
 * whole reason the realtime de-esser can have live knobs at all.
 *
 * THE SPLIT THAT MAKES THIS WORK. Sibilance detection is expensive, needs
 * Silero-grade voicing labels and an F0 contour, and produces two numbers per
 * event: how loud the event peaked (`eventPeakDb`) and how loud the speech
 * around it sits (`contextRmsDb`). Neither depends on any attenuation setting.
 * So detection runs once, server-side, and freezes — while ceiling, ratio, cap
 * and fades are pure functions of those two numbers and recompute in about a
 * millisecond for a whole file.
 *
 * A parameter belongs on the realtime panel if it only reads those two numbers,
 * and behind re-analysis if it changes the event set or the measurements
 * themselves. `contextWindowMs` is the one that looks live and is not: it
 * changes how `contextRmsDb` was measured, so it cannot be re-derived here.
 *
 * The events this consumes must be the `measuredEvents` list, not
 * `treatedEvents` — an event the server declined at its ceiling has to be
 * available for a lower ceiling chosen later.
 */

export const CLIP_GAIN_DEFAULTS = {
  stridentCeilingDb: 6.0,
  nonStridentCeilingDb: -4.0,
  reductionRatio: 0.5,
  maxReductionDb: 8.0,
}

/**
 * Decide the gain reduction for each event under the current settings.
 *
 * @param {Array<{startSample:number, endSample:number, eventType?:string,
 *                sibilantClass?:string, eventPeakDb:number,
 *                contextRmsDb:number}>} measuredEvents
 * @param {Partial<typeof CLIP_GAIN_DEFAULTS>} [params]
 * @returns {Array<object>} treated events, each with `gainDb`, ready for
 *   buildClipGainEnvelope. Events at or under their ceiling are omitted, as
 *   the Python omits them — but they stay in the input for next time.
 */
export function decideClipGains(measuredEvents, params = {}) {
  const p = { ...CLIP_GAIN_DEFAULTS, ...params }
  const treated = []

  for (const ev of measuredEvents) {
    const ceilingDb = ev.sibilantClass === 'non_strident'
      ? p.nonStridentCeilingDb
      : p.stridentCeilingDb

    const excessDb = ev.eventPeakDb - (ev.contextRmsDb + ceilingDb)
    if (excessDb <= 0) continue

    const gainDb = -Math.min(excessDb * p.reductionRatio, p.maxReductionDb)
    treated.push({ ...ev, ceilingDb, excessDb, gainDb })
  }

  return treated
}

/** Deepest reduction any event will take, as a positive dB figure. */
export function maxReductionOf(treatedEvents) {
  let max = 0
  for (const ev of treatedEvents) {
    const abs = Math.abs(ev.gainDb)
    if (abs > max) max = abs
  }
  return max
}
