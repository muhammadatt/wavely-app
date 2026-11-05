<script setup>
/**
 * PLUGIN CHAIN — the rack every engaged plugin plays through.
 *
 * + ADD PLUGIN opens a picker (the Search Operations palette, narrowed to the
 * plugins that can run in the chain); picking one appends it and opens it to
 * tune. That picker is the ONLY way into the chain — opening a plugin from the
 * rail opens its own SOLO copy, with its own settings and Apply, and closes this
 * window (useWindows.js); a slot is the plugin's separate CHAIN copy.
 * Plugins in the chain may all be open beside this window, and none of them
 * has an Apply of its own: this window's Apply is the one.
 *
 * One row per slot, in processing order (top runs first): its lamp is the
 * plugin's own ON/BYPASS, EDIT reopens its faceplate, the arrows (or a drag)
 * move it, × takes it out of the chain. The header's ON/BYPASS takes the whole
 * chain out of circuit at once; Apply renders every live slot over the
 * selection in order and commits the result as one undo step.
 *
 * The rack is a view: the slots live in the EffectChain (see
 * usePluginChain.js), so a plugin's window and this one can never disagree.
 *
 * CALIBRATION (with two or more live slots): each slot's PREVIEW measures what
 * the slots above it hand it, as Apply does — but getting that means rendering
 * them, an Apply's worth of work, so it runs on CALIBRATE or, in AUTO, by
 * itself whenever something upstream changes. A slot measuring audio it will
 * not hear is marked STALE. See `useChainCalibration`.
 */
import { computed, ref } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import { usePluginChain, useChainCalibration } from '../../../composables/usePluginChain.js'
import { baseId } from '../../../composables/pluginCopies.js'
import FloatingWindow from '../FloatingWindow.vue'
import PluginPicker from '../../PluginPicker.vue'
import ModulaLedPill from '../../modula/ModulaLedPill.vue'
import ModulaSegmented from '../../modula/ModulaSegmented.vue'

defineProps({ z: { type: Number, default: 500 } })

const { state } = useEditorState()
const {
  slots, liveSlots, bypassed, add,
  setSlotActive, remove, clear, move, setBypassed, openEditor, applyBlocker, apply,
} = usePluginChain()

const ACCENT = '#e8a33d'

// ── Calibration ─────────────────────────────────────────────────────────────
const calibration = useChainCalibration()
const CALIBRATION_MODES = [
  { value: 'manual', label: 'MANUAL', title: 'Calibrate when you press the button — for long files' },
  { value: 'auto', label: 'AUTO', title: 'Re-calibrate by itself whenever something upstream changes' },
]
const calibrationNote = computed(() => {
  if (calibration.running.value) return `Calibrating… ${Math.round(calibration.progress.value * 100)} %`
  if (calibration.error.value) return calibration.error.value
  if (calibration.needed.value) {
    return calibration.mode.value === 'auto'
      ? 'Something upstream changed — re-calibrating'
      : 'Out of date: later plugins are measuring audio they won’t hear. Calibrate before you judge or apply'
  }
  return 'Calibrated: every plugin measures what the ones above it hand it'
})

// Selection is FloatingWindow's to explain; everything else is ours.
const blocker = computed(() => (state.selection ? applyBlocker() : ''))
const applyLabel = computed(() => {
  const n = liveSlots.value.length
  return n > 1 ? `Apply ${n} plugins to selection` : 'Apply chain to selection'
})

// ── Add picker ──────────────────────────────────────────────────────────────
const pickerOpen = ref(false)
// The picker lists plugins by their own (solo) ids; a slot is the chain's copy.
const memberWindowIds = computed(() => slots.value.map(s => baseId(s.windowId)))

function pick(id) {
  pickerOpen.value = false
  add(id)
}

function togglePlayback() {
  window.dispatchEvent(new CustomEvent('wavely:toggle-play'))
}

// ── Drag to reorder ─────────────────────────────────────────────────────────
// Native drag and drop, row onto row: the dragged slot takes the target's
// place. The arrows do the same one step at a time for keyboard users.
const dragId = ref(null)
const overIndex = ref(-1)

function onDragStart(e, id) {
  dragId.value = id
  e.dataTransfer.effectAllowed = 'move'
  // Firefox will not start a drag without data.
  e.dataTransfer.setData('text/plain', id)
}
function onDragOver(e, index) {
  if (dragId.value === null) return
  e.preventDefault()
  overIndex.value = index
}
function onDrop(index) {
  if (dragId.value !== null) move(dragId.value, index)
  onDragEnd()
}
function onDragEnd() {
  dragId.value = null
  overIndex.value = -1
}
</script>

<template>
  <FloatingWindow
    window-id="plugin-chain"
    :z="z"
    :width="480"
    :accent="ACCENT"
    design="modula"
    brand-lead="PLUGIN CHAIN"
    :engaged="!bypassed"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
    apply-feature="pluginChainApply"
    :apply-label="applyLabel"
    apply-label-short="Apply chain"
    :apply-disabled="!!blocker"
    :apply-disabled-hint="blocker"
    @toggle-engaged="setBypassed(!bypassed)"
    @toggle-preview="togglePlayback"
    @apply="apply()"
  >
    <div class="pc-panel">
      <div class="pc-head">
        <span class="pc-caption">SIGNAL FLOW · TOP RUNS FIRST</span>
        <span class="pc-head-actions">
          <button
            v-if="slots.length"
            type="button" class="pc-text-btn"
            title="Take every plugin out of the chain"
            @click="clear()"
          >Clear</button>
          <button
            type="button" class="pc-text-btn pc-add-btn"
            aria-haspopup="dialog"
            title="Add a plugin to the end of the chain"
            @click="pickerOpen = true"
          >+ Add plugin</button>
        </span>
      </div>

      <ol v-if="slots.length" class="pc-list" :class="{ 'is-bypassed': bypassed }">
        <li
          v-for="(slot, i) in slots"
          :key="slot.id"
          class="pc-row"
          :class="{ 'is-off': !slot.active, 'is-dragging': dragId === slot.id, 'is-over': overIndex === i && dragId !== slot.id }"
          draggable="true"
          @dragstart="onDragStart($event, slot.id)"
          @dragover="onDragOver($event, i)"
          @drop.prevent="onDrop(i)"
          @dragend="onDragEnd"
        >
          <span class="pc-grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
          <span class="pc-index">{{ i + 1 }}</span>
          <ModulaLedPill
            size="sm" on-label="ON" off-label="BYPASS" :color="ACCENT"
            :model-value="slot.active"
            :title="slot.active ? `Bypass ${slot.label}` : `Turn ${slot.label} on`"
            @update:model-value="setSlotActive(slot.id, $event)"
          />
          <span class="pc-name">{{ slot.label }}</span>
          <span
            v-if="slot.active && calibration.stateOf(slot.id) === 'stale'"
            class="pc-stale"
            title="Measuring audio it won't hear: something above it changed since the last calibration"
          >STALE</span>
          <span class="pc-actions">
            <button
              type="button" class="pc-icon-btn" :disabled="i === 0"
              :aria-label="`Move ${slot.label} earlier`" title="Move earlier in the chain"
              @click="move(slot.id, i - 1)"
            >↑</button>
            <button
              type="button" class="pc-icon-btn" :disabled="i === slots.length - 1"
              :aria-label="`Move ${slot.label} later`" title="Move later in the chain"
              @click="move(slot.id, i + 1)"
            >↓</button>
            <button
              type="button" class="pc-text-btn" :disabled="!slot.windowId"
              :title="`Open ${slot.label}`"
              @click="openEditor(slot.id)"
            >Edit</button>
            <button
              type="button" class="pc-icon-btn"
              :aria-label="`Remove ${slot.label} from the chain`" title="Remove from the chain"
              @click="remove(slot.id)"
            >×</button>
          </span>
        </li>
      </ol>

      <p v-else class="pc-empty">
        No plugins yet. Use + Add plugin — each one joins the end of the chain
        and keeps playing when its window closes
      </p>

      <div v-if="calibration.applicable.value" class="pc-calibrate" :class="{ 'is-needed': calibration.needed.value }">
        <button
          type="button" class="pc-text-btn pc-calibrate-btn"
          :disabled="calibration.running.value"
          title="Render the chain over the preview region so each plugin measures what it will hear (the selection, or the whole file)"
          @click="calibration.calibrate()"
        >{{ calibration.running.value ? 'Calibrating…' : 'Calibrate' }}</button>
        <ModulaSegmented
          :model-value="calibration.mode.value" :options="CALIBRATION_MODES"
          aria-label="Calibration mode"
          @update:model-value="calibration.setMode"
        />
        <span class="pc-calibrate-note" role="status">{{ calibrationNote }}</span>
      </div>

      <p v-if="slots.length" class="pc-note">
        <template v-if="bypassed">Chain bypassed — you are hearing the file as it is</template>
        <template v-else-if="liveSlots.length">
          {{ liveSlots.length }} of {{ slots.length }} live · Apply renders them in this order as one undo step
        </template>
        <template v-else>Every slot is bypassed</template>
      </p>
    </div>
  </FloatingWindow>

  <!-- To the body: the window is a transformed, clipped box, and the picker is
       a full-screen dialog like the palette it mirrors. -->
  <Teleport to="body">
    <PluginPicker
      v-if="pickerOpen"
      :in-chain="memberWindowIds"
      @pick="pick"
      @close="pickerOpen = false"
    />
  </Teleport>
</template>

<style scoped>
.pc-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 14px 12px;
  border-radius: 16px;
  background: var(--m-panel);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .06), 0 0 0 1px rgba(0, 0, 0, .5);
}
.pc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}
.pc-head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pc-add-btn { color: var(--m-accent); }
.pc-caption {
  font: 700 9px/1 var(--m-font-mono);
  letter-spacing: .16em;
  color: var(--m-ink-4);
}
.pc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pc-list.is-bypassed { opacity: .55; }
.pc-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 12px;
  background: var(--m-well);
  box-shadow: var(--m-shadow-well);
  cursor: grab;
}
.pc-row.is-dragging { opacity: .4; }
.pc-row.is-over { box-shadow: var(--m-shadow-well), 0 -2px 0 0 var(--m-accent); }
.pc-grip {
  font: 700 10px/1 var(--m-font-mono);
  letter-spacing: -.2em;
  color: var(--m-ink-off);
}
.pc-index {
  width: 14px;
  text-align: right;
  font: 600 10px/1 var(--m-font-mono);
  color: var(--m-ink-4);
  font-variant-numeric: tabular-nums;
}
.pc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 600 12px/1.2 var(--m-font-ui);
  color: var(--m-ink);
}
.pc-row.is-off .pc-name { color: var(--m-ink-4); }
.pc-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pc-icon-btn,
.pc-text-btn {
  height: 26px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--m-ink-2);
  box-shadow: var(--m-shadow-raised);
  cursor: pointer;
}
.pc-icon-btn {
  width: 26px;
  font: 600 13px/1 var(--m-font-ui);
}
.pc-text-btn {
  padding: 0 10px;
  font: 700 9.5px/1 var(--m-font-mono);
  letter-spacing: .12em;
  text-transform: uppercase;
}
.pc-icon-btn:hover:not(:disabled),
.pc-text-btn:hover:not(:disabled) { filter: brightness(1.15); color: var(--m-ink); }
.pc-icon-btn:disabled,
.pc-text-btn:disabled { opacity: .35; cursor: default; }
.pc-empty,
.pc-note {
  margin: 0;
  font: 500 10.5px/1.5 var(--m-font-ui);
  color: var(--m-ink-4);
}
.pc-empty {
  padding: 18px 8px;
  text-align: center;
}
.pc-stale {
  padding: 2px 6px;
  border-radius: 6px;
  font: 700 8.5px/1 var(--m-font-mono);
  letter-spacing: .12em;
  color: #1a1206;
  background: var(--m-accent);
}
.pc-calibrate {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 12px;
  background: var(--m-well);
  box-shadow: var(--m-shadow-well);
}
.pc-calibrate.is-needed .pc-calibrate-btn { color: var(--m-accent); }
.pc-calibrate-note {
  flex: 1 1 100%;
  font: 500 10.5px/1.4 var(--m-font-ui);
  color: var(--m-ink-4);
}
.pc-calibrate.is-needed .pc-calibrate-note { color: var(--m-ink-2); }
</style>
