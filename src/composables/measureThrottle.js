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

  async function pump() {
    inFlight = true
    try {
      await run()
    } catch (err) {
      // ⚠ SWALLOWED ON PURPOSE, and the alternative is a reported symptom.
      // A rejection escaping here is an unhandled promise rejection that also
      // skips the re-arm below, so one failed pass would leave the makeup
      // frozen for the rest of the session — "stuck without updates". Callers
      // log their own failures; this only has to keep the pump turning.
      console.error('measurement pass failed:', err)
    } finally {
      inFlight = false
    }
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

    /**
     * Stop the throttle re-arming. Used on teardown and when AUTO is switched
     * off — from that moment no NEW pass is started on the old request's
     * behalf.
     *
     * ⚠ IT DOES NOT CLEAR `inFlight`, AND CLEARING IT ALLOWED TWO PASSES AT
     * ONCE. A pass that is already awaiting cannot be aborted, so marking the
     * throttle idle while it runs let the next `schedule()` — AUTO toggled
     * straight back on, or a panel reopened — start a second `run()` alongside
     * it. Measured: two concurrent passes, which is exactly the coalescing this
     * exists to provide, defeated. Leaving `inFlight` set means such a
     * `schedule()` is queued behind the running pass instead, and still runs.
     *
     * A pass in flight across a cancel is not otherwise a hazard: its result is
     * discarded by the caller's own sequence check.
     */
    cancel() {
      dirty = false
    },

    isBusy: () => inFlight,
  }
}
