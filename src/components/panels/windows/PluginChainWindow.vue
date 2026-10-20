<script setup>
/**
 * PLUGIN CHAIN — the rack every engaged plugin plays through.
 *
 * + ADD PLUGIN pops out the list of plugins that can run in the chain; picking
 * one appends it and opens it to tune. That list is the ONLY way into the
 * chain (besides the + CHAIN pill on a plugin's own window) — opening a plugin
 * from the rail auditions it on its own.
 *
 * One row per slot, in processing order (top runs first): its lamp is the
 * plugin's own ON/BYPASS, EDIT reopens its faceplate, the arrows (or a drag)
 * move it, × takes it out of the chain. The header's ON/BYPASS takes the whole
 * chain out of circuit at once; Apply renders every live slot over the
 * selection in order and commits the result as one undo step.
 *
 * The rack is a view: the slots live in the EffectChain (see
 * usePluginChain.js), so a plugin's window and this one can never disagree.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditorState } from '../../../composables/useEditorState.js'
import { usePluginChain } from '../../../composables/usePluginChain.js'
import { chainPlugins } from '../../../ui/registry.js'
import FloatingWindow from '../FloatingWindow.vue'
import ModulaLedPill from '../../modula/ModulaLedPill.vue'

defineProps({ z: { type: Number, default: 500 } })

const { state } = useEditorState()
const {
  slots, liveSlots, bypassed, add,
  setSlotActive, remove, clear, move, setBypassed, openEditor, applyBlocker, apply,
} = usePluginChain()

const ACCENT = '#e8a33d'

// Selection is FloatingWindow's to explain; everything else is ours.
const blocker = computed(() => (state.selection ? applyBlocker() : ''))
const applyLabel = computed(() => {
  const n = liveSlots.value.length
  return n > 1 ? `Apply ${n} plugins to selection` : 'Apply chain to selection'
})

// ── Add list ────────────────────────────────────────────────────────────────
const addOpen = ref(false)
const addEl = ref(null)
const menuEl = ref(null)

// The chain-capable plugins in the registry's order, bucketed by its groups.
// Read at render, never at module load: the registry imports this window.
const addGroups = computed(() => {
  const inChain = new Set(slots.value.map(s => s.windowId))
  const groups = []
  const byName = new Map()
  for (const op of chainPlugins()) {
    let g = byName.get(op.group)
    if (!g) { g = { group: op.group, items: [] }; byName.set(op.group, g); groups.push(g) }
    g.items.push({ id: op.id, label: op.label, desc: op.desc, member: inChain.has(op.id) })
  }
  return groups
})

function pick(id) {
  addOpen.value = false
  add(id)
}

function onOutside(e) {
  if (addEl.value?.contains(e.target) || menuEl.value?.contains(e.target)) return
  addOpen.value = false
}
watch(addOpen, (open) => {
  if (open) document.addEventListener('pointerdown', onOutside, true)
  else document.removeEventListener('pointerdown', onOutside, true)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true))

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
    :width="440"
    :accent="ACCENT"
    design="modula"
    brand-lead="PLUGIN CHAIN"
    :engaged="!bypassed"
    show-preview
    previewable
    :previewing="state.isPlaying"
    show-apply
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
          <span ref="addEl" class="pc-add">
            <button
              type="button" class="pc-text-btn pc-add-btn"
              :aria-expanded="String(addOpen)" aria-haspopup="menu"
              title="Add a plugin to the end of the chain"
              @click="addOpen = !addOpen"
            >+ Add plugin</button>
          </span>
        </span>
      </div>

      <!-- In the panel's flow rather than floating over it: the window body is
           a scroller, and a short chain would clip a pop-over. -->
      <div v-if="addOpen" ref="menuEl" class="pc-menu" role="menu" @keydown.esc.stop="addOpen = false">
        <div v-for="g in addGroups" :key="g.group" class="pc-menu-group">
          <div class="pc-menu-caption">{{ g.group }}</div>
          <button
            v-for="item in g.items" :key="item.id"
            type="button" role="menuitem" class="pc-menu-item"
            :disabled="item.member"
            :title="item.member ? `${item.label} is already in the chain` : item.desc"
            @click="pick(item.id)"
          >
            <span class="pc-menu-label">{{ item.label }}</span>
            <span v-if="item.member" class="pc-menu-tag">IN CHAIN</span>
            <span v-else class="pc-menu-desc">{{ item.desc }}</span>
          </button>
        </div>
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

      <p v-if="slots.length" class="pc-note">
        <template v-if="bypassed">Chain bypassed — you are hearing the file as it is</template>
        <template v-else-if="liveSlots.length">
          {{ liveSlots.length }} of {{ slots.length }} live · Apply renders them in this order as one undo step
        </template>
        <template v-else>Every slot is bypassed</template>
      </p>
    </div>
  </FloatingWindow>
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
.pc-add { position: relative; }
.pc-add-btn { color: var(--m-accent); }
.pc-menu {
  max-height: 320px;
  overflow-y: auto;
  padding: 6px;
  border-radius: 12px;
  background: #1d232c;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .7), 0 16px 32px -8px rgba(0, 0, 0, .9);
}
.pc-menu-caption {
  padding: 8px 8px 4px;
  font: 700 8.5px/1 var(--m-font-mono);
  letter-spacing: .16em;
  text-transform: uppercase;
  color: var(--m-ink-4);
}
.pc-menu-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.pc-menu-item:hover:not(:disabled) { background: rgba(255, 255, 255, .07); }
.pc-menu-item:disabled { cursor: default; opacity: .5; }
.pc-menu-label {
  flex-shrink: 0;
  font: 600 12px/1.2 var(--m-font-ui);
  color: var(--m-ink);
}
.pc-menu-desc {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: 500 10.5px/1.2 var(--m-font-ui);
  color: var(--m-ink-4);
}
.pc-menu-tag {
  margin-left: auto;
  font: 700 8.5px/1 var(--m-font-mono);
  letter-spacing: .12em;
  color: var(--m-accent);
}
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
</style>
