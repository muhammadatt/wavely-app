/**
 * Building a tone-probe stimulus from an event plan.
 *
 * A plan is a list of level events on a sine probe. Between events the probe
 * sits at the plan's rest level; during an event it sits at that event's level.
 * The waveform is built with CONTINUOUS PHASE across the whole file, so a
 * frequency change during a rest cannot step the waveform.
 *
 * PLAN SHAPE
 *   {
 *     seconds,                 total length
 *     lowDb,                   rest level, dBFS
 *     events: [{ tag, freqHz, hiDb, up, down, ... }],   up/down in seconds
 *     isRamp?, envAt?(tSec)    a continuously-swept plan instead of steps
 *   }
 *
 * Extra keys on an event are ignored here and are how a fitter finds its own
 * data later (`role`, `gap`, `T`, `L` are all in use).
 */

const lin = d => Math.pow(10, d / 20)

/**
 * Every event carries its own probe frequency and levels. Steps land on a ZERO
 * CROSSING of that probe, which is what lets the edge be instantaneous: the
 * waveform value is continuous across it (only its derivative jumps), so there
 * is nothing to click and no fade to blur the attack.
 *
 * ⚠ THE FADE THIS REPLACED IS WHAT BLINDED THE FIRST STIMULUS. A 5 ms
 * raised-cosine edge cannot measure a 1-2 ms attack, and the symptom was read
 * as a limitation of the envelope detector rather than of the stimulus.
 */
export function snapToZeroCrossing(tSec, freqHz) {
  const halfPeriod = 1 / (2 * freqHz)
  return Math.round(tSec / halfPeriod) * halfPeriod
}

/**
 * Render a plan to samples.
 *
 * @returns {{ x: Float32Array, env: Float64Array, freq?: Float64Array }}
 *   `x` is the waveform, `env` its exact instantaneous amplitude. ⚠ `env` IS
 *   THE REFERENCE HALF OF EVERY MEASUREMENT DOWNSTREAM — the gain trace divides
 *   a capture by it and the alignment fits against it — so it is returned
 *   rather than re-derived, and it is exact by construction because we wrote
 *   the signal rather than recorded it.
 */
export function buildProbe(plan, sampleRate) {
  const n = Math.round(plan.seconds * sampleRate)
  const x = new Float32Array(n)
  const probeHz = plan.events[0]?.freqHz
  if (!probeHz) throw new Error('buildProbe: plan has no events to take a probe frequency from')

  if (plan.isRamp) {
    const env = new Float64Array(n)
    let phase = 0
    for (let i = 0; i < n; i++) {
      env[i] = plan.envAt(i / sampleRate)
      x[i] = env[i] * Math.sin(phase)
      phase += 2 * Math.PI * probeHz / sampleRate
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI
    }
    return { x, env }
  }

  const env = new Float64Array(n).fill(lin(plan.lowDb))
  const freq = new Float64Array(n).fill(probeHz)

  // Each event owns the span from halfway back to the previous event.
  for (let e = 0; e < plan.events.length; e++) {
    const ev = plan.events[e]
    const prev = plan.events[e - 1]
    const from = prev ? Math.round(((prev.down + ev.up) / 2) * sampleRate) : 0
    const to = e + 1 < plan.events.length
      ? Math.round(((ev.down + plan.events[e + 1].up) / 2) * sampleRate) : n
    for (let i = Math.max(0, from); i < Math.min(n, to); i++) freq[i] = ev.freqHz
    const a = Math.round(ev.up * sampleRate), b = Math.round(ev.down * sampleRate)
    for (let i = Math.max(0, a); i < Math.min(n, b); i++) env[i] = lin(ev.hiDb)
  }
  // Continuous phase, so a frequency change mid-rest cannot step the waveform.
  let phase = 0
  for (let i = 0; i < n; i++) {
    x[i] = env[i] * Math.sin(phase)
    phase += 2 * Math.PI * freq[i] / sampleRate
    if (phase > 2 * Math.PI) phase -= 2 * Math.PI
  }
  return { x, env, freq }
}
