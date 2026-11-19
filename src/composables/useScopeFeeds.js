import { ref, watch } from 'vue'
import { useEditorState } from './useEditorState.js'
import { readTimelineEnvelope } from '../audio/timelineEnvelope.js'
import { createPeakHold, useMeterFrame } from '../components/meters/ballistics.js'

/**
 * What the activity scopes and held reduction readouts are fed — the De-Esser,
 * the Plosive Tamer and the Soft Clipper each had their own copy. Call these
 * from a window's setup: they live as long as the window.
 */

/**
 * The timeline's peak envelope around the playhead, for a scope's lookahead
 * (and its history while the effect is bypassed): `envelope(offsetSeconds,
 * seconds, columns)` → a Float32Array of `columns` peaks, or null with no
 * audio.
 *
 * It comes from the timeline rather than the effect because the effect has
 * not seen it — the kernel's ring only holds audio it has processed, which is
 * nothing while bypassed and nothing ahead of the playhead ever. Read live from
 * the playhead, so the picture slides under a stationary playhead, and works
 * with the transport stopped.
 *
 * ⚠ ONE SCRATCH PER SIDE. Both halves are read in the same frame, so a single
 * shared buffer would have the second call overwrite the first — the two
 * halves would show the same audio.
 */
export function useTimelineEnvelope() {
  const { state } = useEditorState()
  const scratch = { ahead: null, behind: null }
  return function envelope(offsetSeconds, seconds, columns) {
    if (!state.segments?.length) return null
    const side = offsetSeconds < 0 ? 'behind' : 'ahead'
    if (scratch[side]?.length !== columns) scratch[side] = new Float32Array(columns)
    return readTimelineEnvelope(state.segments, state.playhead + offsetSeconds, seconds, columns, scratch[side])
  }
}

/** How far the playhead may have moved while stopped before the history no longer describes it. */
export const SCOPE_RESUME_TOLERANCE_S = 0.25

/**
 * The scope-hold rule, as a step: given whether the transport plays, where the
 * playhead is and where it stopped (null while playing), say whether to hold
 * the scope, whether to clear its history, and the new stop position.
 *
 * The scope freezes on what last played while the transport is stopped — the
 * worklet keeps running on silence and would scroll it away — and starts over
 * if playback resumes somewhere else (a seek, a click on the timeline): its
 * history would describe audio that is no longer behind the playhead.
 */
export function scopeTransportStep({ playing, playhead, stoppedAt }) {
  if (playing) {
    const moved = stoppedAt !== null && Math.abs(playhead - stoppedAt) > SCOPE_RESUME_TOLERANCE_S
    return { hold: false, clear: moved, stoppedAt: null }
  }
  return { hold: true, clear: false, stoppedAt: playhead }
}

/**
 * Wire the scope-hold rule to the transport. `engaged` is the plugin's
 * ON/BYPASS (re-evaluated when it changes); `holdScope` / `clearScope` are its
 * composable's.
 */
export function useScopeTransportHold({ engaged, holdScope, clearScope }) {
  const { state } = useEditorState()
  let stoppedAt = null
  watch(() => [state.isPlaying, engaged.value], ([playing]) => {
    const step = scopeTransportStep({ playing, playhead: state.playhead, stoppedAt })
    if (step.clear) clearScope()
    stoppedAt = step.stoppedAt
    holdScope(step.hold)
  }, { immediate: true })
}

/**
 * Held readings: each source held at its peak for `holdMs`, then falling at
 * `fallPerSec` — a 30 ms "s" or burst is a frame or two, and read raw it
 * flickers past unseen. `step(dtMs)` advances them and returns the held values;
 * `everyMs` > 0 publishes at most that often (text that changes every frame
 * cannot be read), 0 every step.
 *
 * @param {Record<string, () => number>} sources
 * @param {{ holdMs: number, fallPerSec: number, everyMs?: number }} opts
 */
export function createHeldReadings(sources, { holdMs, fallPerSec, everyMs = 0 }) {
  const holds = Object.fromEntries(Object.keys(sources).map(k => [k, createPeakHold({ holdMs, fallPerSec })]))
  let since = everyMs // the first step publishes, rather than showing a stale zero
  let shown = Object.fromEntries(Object.keys(sources).map(k => [k, 0]))
  return {
    step(dt) {
      const next = Object.fromEntries(Object.entries(sources).map(([k, read]) => [k, holds[k].push(read(), dt)]))
      since += dt
      if (since >= everyMs) {
        since = 0
        shown = next
      }
      return shown
    },
  }
}

/** `createHeldReadings` on the animation frame, as a ref, for a window's lifetime. */
export function useHeldReadings(sources, opts) {
  const held = createHeldReadings(sources, opts)
  const shown = ref(held.step(0))
  useMeterFrame((dt) => { shown.value = held.step(dt) })
  return shown
}
