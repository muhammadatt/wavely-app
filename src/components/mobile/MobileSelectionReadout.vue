<script setup>
import { computed, onBeforeUnmount } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useSelectionActions } from '../../composables/useSelectionActions.js'

/**
 * The selection's edges, length and nudges: a strip meant for the waveform
 * area, above the scrollbar (not mounted yet — it did not fit the phone
 * layout). The nudge buttons are disabled with nothing selected, and the
 * edge times appear with a selection. It used to be the top row of
 * MobileSelectionBar.
 *
 * Each edge's time sits between ‹ › nudge buttons: a tap moves that edge one
 * step (about 3 px at the current zoom, a round number — finer when zoomed
 * in), and holding repeats, for the precision a finger cannot reach. A
 * looping selection follows the nudge as it plays.
 */
const { state } = useEditorState()
const { nudge, nudgeSeconds } = useSelectionActions()

// Milliseconds once the step is finer than 10 ms, so a nudge always shows.
const decimals = computed(() => (nudgeSeconds.value < 0.01 ? 3 : 2))

function time(seconds) {
  const m = Math.floor(seconds / 60)
  const d = decimals.value
  return `${m}:${(seconds % 60).toFixed(d).padStart(d + 3, '0')}`
}

const readout = computed(() => {
  const sel = state.selection
  if (!sel) return null
  return { start: time(sel.start), end: time(sel.end), length: `${(sel.end - sel.start).toFixed(decimals.value)} s` }
})

// ── Press and hold repeats ──────────────────────────────────────────────────
const HOLD_DELAY_MS = 380
const HOLD_EVERY_MS = 60
let holdTimer = null

function stopHold() {
  clearTimeout(holdTimer)
  clearInterval(holdTimer)
  holdTimer = null
}

function startHold(edge, direction) {
  stopHold()
  nudge(edge, direction)
  holdTimer = setTimeout(() => {
    holdTimer = setInterval(() => nudge(edge, direction), HOLD_EVERY_MS)
  }, HOLD_DELAY_MS)
}

// A keyboard press (Enter / Space) arrives as a click with no pointer.
function keyNudge(e, edge, direction) {
  if (e.detail === 0) nudge(edge, direction)
}

onBeforeUnmount(stopHold)
</script>

<template>
  <div class="m-sel-row" data-testid="mobile-selection-readout">
    <div v-for="edge in ['start', 'end']" :key="edge" class="m-edge" :class="`m-edge-${edge}`">
      <button
        type="button"
        class="m-nudge"
        :disabled="!readout"
        :aria-label="`Move the ${edge} earlier`"
        :data-testid="`nudge-${edge}-back`"
        @pointerdown.prevent="readout && startHold(edge, -1)"
        @pointerup="stopHold"
        @pointerleave="stopHold"
        @pointercancel="stopHold"
        @click="keyNudge($event, edge, -1)"
      >‹</button>
      <span v-if="readout" class="m-edge-time" :data-testid="`edge-${edge}`">{{ readout[edge] }}</span>
      <button
        type="button"
        class="m-nudge"
        :disabled="!readout"
        :aria-label="`Move the ${edge} later`"
        :data-testid="`nudge-${edge}-fwd`"
        @pointerdown.prevent="readout && startHold(edge, 1)"
        @pointerup="stopHold"
        @pointerleave="stopHold"
        @pointercancel="stopHold"
        @click="keyNudge($event, edge, 1)"
      >›</button>
    </div>
    <span class="m-sel-len" :class="{ 'm-dim': !readout }">{{ readout ? readout.length : 'No selection' }}</span>
  </div>
</template>

<style scoped>
.m-sel-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  min-height: 30px;
  background: var(--mob-bar-bg);
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}
.m-edge { display: flex; align-items: center; gap: 2px; }
.m-edge-end { order: 2; }
.m-edge-time { font-size: 12px; font-weight: 600; color: #eaf6f8; min-width: 0; }
.m-nudge {
  width: 30px;
  height: 30px;
  flex: none;
  border: none;
  border-radius: 8px;
  background: rgba(255,255,255,.06);
  color: #e8a33d;
  font: 700 17px 'Inter', sans-serif;
  line-height: 1;
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
}
.m-nudge:disabled { opacity: .5; }
.m-dim { color: rgba(255,255,255,.45) !important; }
.m-nudge:active { background: rgba(232,163,61,.2); }
.m-sel-len { order: 1; flex: 1; text-align: center; font-size: 11px; color: #e8a33d; }
</style>
