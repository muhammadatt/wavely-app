<script setup>
import { computed, ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import ApplyAction from '../ui/ApplyAction.vue'
import Icon from '../ui/Icon.vue'
import { formatTimecode } from '../../utils/format.js'

/**
 * The markers rail panel.
 *
 * No header: as a rail operation, ContextPanel draws the title block and the
 * back chevron from the registry entry.
 *
 * The list here is where names are always legible — the canvas drops a name
 * rather than let it collide with its neighbour, so this is the surface that
 * has to show all of them.
 */
const {
  state,
  appState,
  hasSelection,
  totalDuration,
  spans,
  dropMarker,
  markSelectionEdges,
  deleteMarker,
  clearMarkers,
  renameMarkerById,
  toggleGapMarker,
  setPlayhead,
  performSplitAtMarkers,
  performDropGaps,
  showToast,
} = useEditorState()

const markers = computed(() => state.markers)
const gapCount = computed(() => spans.value.filter(s => s.kind === 'gap').length)

// Which marker's name is being edited. Renaming commits on blur or Enter
// rather than per keystroke, so a rename is one undo entry and not one per
// character typed.
const editingId = ref(null)
const draftName = ref('')

function startRename(marker) {
  editingId.value = marker.id
  draftName.value = marker.name
}

function commitRename() {
  const id = editingId.value
  if (!id) return
  editingId.value = null
  const marker = markers.value.find(m => m.id === id)
  if (marker && marker.name !== draftName.value) renameMarkerById(id, draftName.value)
}

function add() {
  if (dropMarker() === null) showToast('There is already a marker here')
}

function addEdges() {
  const added = markSelectionEdges()
  showToast(added ? `Added ${added} marker${added === 1 ? '' : 's'}` : 'Both edges are already marked')
}

function splitAll() {
  const n = performSplitAtMarkers()
  showToast(`Split at ${n} marker${n === 1 ? '' : 's'}`)
}

function dropGaps() {
  const n = performDropGaps()
  showToast(`Dropped ${n} gap${n === 1 ? '' : 's'}`)
}

function clearAll() {
  clearMarkers()
  showToast('Markers cleared')
}
</script>

<template>
  <div class="font-['Inter'] pb-4">
    <!-- Placement -->
    <div class="p-4 flex flex-col gap-2 border-b border-[rgba(255,255,255,.06)]">
      <button
        class="marker-action"
        :disabled="totalDuration <= 0"
        @click="add"
      >
        <Icon name="markers" :size="13" :stroke-width="2" />
        Add marker at playhead
        <span class="marker-key">M</span>
      </button>

      <button
        class="marker-action"
        :disabled="!hasSelection"
        :title="hasSelection ? '' : 'Make a selection first'"
        @click="addEdges"
      >
        <Icon name="selectAll" :size="13" :stroke-width="2" />
        Mark selection edges
      </button>

      <label class="flex items-center gap-2 mt-1 px-[2px] cursor-pointer select-none">
        <input
          type="checkbox"
          class="accent-[#ffb454] w-[13px] h-[13px] cursor-pointer"
          :checked="appState.snapToZero"
          @change="appState.snapToZero = $event.target.checked"
        />
        <span class="text-[11.5px] font-medium text-[rgba(255,255,255,.72)]">Snap to zero</span>
      </label>
      <p class="text-[10.5px] leading-[1.45] text-[rgba(255,255,255,.38)] px-[2px]">
        Places markers on the nearest rising zero-crossing, so a cut there
        doesn't click. Turn it off to mark an exact time.
      </p>
    </div>

    <!-- The list -->
    <div class="px-4 pt-3">
      <div class="flex items-baseline justify-between mb-2">
        <span class="text-[11px] font-bold uppercase tracking-[.06em] text-[rgba(255,255,255,.42)]">
          {{ markers.length }} marker{{ markers.length === 1 ? '' : 's' }}
        </span>
        <button
          v-if="markers.length"
          class="text-[10.5px] font-semibold text-[rgba(255,255,255,.42)] hover:text-[#ff8a80] bg-transparent border-none cursor-pointer p-0"
          @click="clearAll"
        >
          Clear all
        </button>
      </div>

      <p
        v-if="!markers.length"
        class="text-[11px] leading-[1.5] text-[rgba(255,255,255,.38)] py-2"
      >
        No markers yet. Markers divide the file into slices — the audio between
        one marker and the next — which you can then cut in a single step.
      </p>

      <ul v-else class="flex flex-col gap-[3px] max-h-[260px] overflow-y-auto -mx-1 px-1">
        <li
          v-for="marker in markers"
          :key="marker.id"
          class="marker-row group"
          :class="marker.kind === 'gap' ? 'is-gap' : ''"
        >
          <button
            class="marker-time"
            title="Move the playhead here"
            @click="setPlayhead(marker.time)"
          >{{ formatTimecode(marker.time) }}</button>

          <input
            v-if="editingId === marker.id"
            v-model="draftName"
            class="marker-name-input"
            placeholder="Name"
            autofocus
            @blur="commitRename"
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="editingId = null"
          />
          <button
            v-else
            class="marker-name"
            :title="marker.name ? 'Rename' : 'Name this slice'"
            @click="startRename(marker)"
          >{{ marker.name || 'Unnamed' }}</button>

          <button
            class="marker-chip"
            :title="marker.kind === 'gap'
              ? 'This slice is marked as dead air'
              : 'Mark the slice after this marker as dead air'"
            @click="toggleGapMarker(marker.id)"
          >{{ marker.kind === 'gap' ? 'gap' : '·' }}</button>

          <button class="marker-del" title="Delete marker" @click="deleteMarker(marker.id)">
            <Icon name="close" :size="10" :stroke-width="2.5" />
          </button>
        </li>
      </ul>
    </div>

    <!-- Actions -->
    <div class="px-4 pt-3 flex flex-col gap-2">
      <ApplyAction
        :met="markers.length > 0"
        message="Add a marker to split at"
        :label="`Split at ${markers.length} marker${markers.length === 1 ? '' : 's'}`"
        icon="split"
        @apply="splitAll"
      />
      <button
        v-if="gapCount"
        class="marker-action is-warn"
        @click="dropGaps"
      >
        <Icon name="cut" :size="13" :stroke-width="2" />
        Delete {{ gapCount }} gap{{ gapCount === 1 ? '' : 's' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.marker-action {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px 13px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.07);
  color: #eaf6f8;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.marker-action:hover:not(:disabled) {
  background: rgba(255, 180, 84, 0.1);
  border-color: rgba(255, 180, 84, 0.4);
}
.marker-action:disabled {
  opacity: 0.4;
  cursor: default;
}
.marker-action.is-warn:hover {
  background: rgba(255, 138, 128, 0.1);
  border-color: rgba(255, 138, 128, 0.4);
}
.marker-key {
  margin-left: auto;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  color: rgba(255, 255, 255, 0.45);
}

.marker-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 7px;
  border-radius: 8px;
  border: 1px solid transparent;
}
.marker-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.marker-row.is-gap {
  border-color: rgba(255, 180, 84, 0.28);
  background: rgba(255, 180, 84, 0.06);
}

.marker-time {
  flex-shrink: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  color: #ffb454;
}
.marker-time:hover {
  text-decoration: underline;
}

.marker-name,
.marker-name-input {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 2px 4px;
  border-radius: 5px;
  background: transparent;
  border: 1px solid transparent;
  font-family: inherit;
  font-size: 11.5px;
  color: #eaf6f8;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.marker-name {
  cursor: text;
}
.marker-name:hover {
  background: rgba(255, 255, 255, 0.05);
}
.marker-row:not(:hover) .marker-name:not(:focus) {
  color: rgba(234, 246, 248, 0.75);
}
.marker-name-input {
  border-color: rgba(255, 180, 84, 0.5);
  outline: none;
}

.marker-chip {
  flex-shrink: 0;
  width: 26px;
  padding: 1px 0;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.05);
  border: none;
  cursor: pointer;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: rgba(255, 255, 255, 0.4);
}
.marker-row.is-gap .marker-chip {
  background: rgba(255, 180, 84, 0.2);
  color: #ffb454;
}

.marker-del {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.3);
  opacity: 0;
  transition: opacity 0.12s ease, color 0.12s ease;
}
.marker-row:hover .marker-del {
  opacity: 1;
}
.marker-del:hover {
  color: #ff8a80;
}
</style>
