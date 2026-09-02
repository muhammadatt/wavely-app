/**
 * Coalescing throttle for the measured-parameter passes (the compressor auto
 * makeups, the Scheps trim, the soft clipper ceiling and makeup).
 *
 * ⚠ IT REPLACED A DEBOUNCE, AND THE DEBOUNCE MEANT NO MEASUREMENT EVER
 * COMPLETED DURING A DRAG. The old shape was: measure on the first move of a
 * burst, then `clearTimeout`/`setTimeout(45 ms)` on every move after it. A
 * pointer drag fires 60-120 moves a second, so the timer was reset before it
 * could ever fire — the leading measurement ran with the value the knob had at
 * the START of the drag, nothing ran while the hand moved, and the trailing
 * pass began 45 ms after release and then took its own 130-900 ms. Reported as
 * a multi-second lag between the Input knob and the gain, and as the makeup
 * being "stuck".
 *
 * THE MEASUREMENT'S OWN DURATION IS THE THROTTLE, which is what makes this both
 * simpler and faster: one pass runs at a time, moves that arrive while it is in
 * flight set a dirty flag, and the moment it lands a fresh pass starts with the
 * CURRENT values. So the knob updates every measurement-length (~130 ms for FET
 * Punch after the closed-form solve) for as long as the hand is moving, instead
 * of once at the start and once well after the end. There is no timer to tune
 * and no queue to build up: at most one pass is in flight and at most one is
 * pending, however fast the input arrives.
 *
 * ⚠ THE FINAL VALUE ALWAYS LANDS. `dirty` is only cleared by the pass that
 * consumes it, so the last move of a drag is guaranteed one measurement after
 * it — which a plain throttle (drop while busy) would lose.
 *
 * @param {() => Promise<void>} run One measurement pass. Must not throw.
 * @returns {{schedule: () => void, cancel: () => void, isBusy: () => boolean}}
 */
export function createMeasureThrottle(run) {
  let inFlight = false
  let dirty = false
  // Bumped by cancel(), so a pass that lands after teardown cannot re-arm.
  let generation = 0

  async function pump() {
    const gen = generation
    inFlight = true
    try {
      await run()
    } catch (err) {
      // ⚠ SWALLOWED ON PURPOSE, and the alternative is the reported symptom.
      // A rejection escaping here is an unhandled promise rejection that also
      // skips the re-arm below, so one failed pass would leave the makeup
      // frozen for the rest of the session — "stuck without updates". Callers
      // log their own failures; this only has to keep the pump turning.
      console.error('measurement pass failed:', err)
    } finally {
      inFlight = false
    }
    if (gen !== generation) return
    if (dirty) {
      dirty = false
      pump()
    }
  }

  return {
    schedule() {
      if (inFlight) { dirty = true; return }
      dirty = false
      pump()
    },
    cancel() {
      generation++
      inFlight = false
      dirty = false
    },
    isBusy: () => inFlight,
  }
}
