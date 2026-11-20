<script setup>
import { computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useSelectionActions } from '../../composables/useSelectionActions.js'
import Icon from '../ui/Icon.vue'

/**
 * The selection's readout and its actions, in place of the desktop's
 * right-click menu. Shown while there is a selection, or something on the
 * clipboard to paste at the playhead.
 */
const { state, hasSelection, hasClipboard, clearSelection, selectAll } = useEditorState()
const { busy, cut, copy, paste, silence, trim } = useSelectionActions()

function time(seconds) {
  const m = Math.floor(seconds / 60)
  return `${m}:${(seconds % 60).toFixed(2).padStart(5, '0')}`
}

const readout = computed(() => {
  const sel = state.selection
  if (!sel) return null
  return { range: `${time(sel.start)} – ${time(sel.end)}`, length: `${(sel.end - sel.start).toFixed(2)} s` }
})
</script>

<template>
  <div class="m-sel" data-testid="mobile-selection-bar">
    <div class="m-sel-row">
      <template v-if="readout">
        <span class="m-sel-range">{{ readout.range }}</span>
        <span class="m-sel-len">{{ readout.length }}</span>
        <button type="button" class="m-sel-x" aria-label="Clear selection" @click="clearSelection">
          <Icon name="close" :size="12" :stroke-width="2.5" />
        </button>
      </template>
      <template v-else>
        <span class="m-sel-hint">Nothing selected</span>
        <button type="button" class="m-sel-all" @click="selectAll">Select all</button>
      </template>
    </div>
    <div class="m-sel-actions">
      <button type="button" class="m-act" :disabled="!hasSelection || busy" @click="cut"><Icon name="cut" :size="17" />Cut</button>
      <button type="button" class="m-act" :disabled="!hasSelection" @click="copy"><Icon name="copy" :size="17" />Copy</button>
      <button type="button" class="m-act" :disabled="!hasClipboard || busy" @click="paste"><Icon name="paste" :size="17" />Paste</button>
      <button type="button" class="m-act" :disabled="!hasSelection || busy" @click="silence"><Icon name="silence" :size="17" />Silence</button>
      <button type="button" class="m-act" :disabled="!hasSelection || busy" @click="trim"><Icon name="trim" :size="17" />Trim</button>
    </div>
  </div>
</template>

<style scoped>
.m-sel {
  flex-shrink: 0;
  background: rgba(232,163,61,.06);
  border-top: 1px solid rgba(232,163,61,.22);
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.m-sel-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 4px;
  min-height: 26px;
  font-family: 'JetBrains Mono', ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}
.m-sel-range { font-size: 12px; font-weight: 600; color: #eaf6f8; }
.m-sel-len { font-size: 11px; color: #e8a33d; }
.m-sel-hint { font: 500 12px 'Inter', sans-serif; color: rgba(255,255,255,.45); }
.m-sel-x, .m-sel-all {
  margin-left: auto;
  border: none;
  background: rgba(255,255,255,.06);
  color: rgba(255,255,255,.7);
  border-radius: 8px;
}
.m-sel-x { width: 26px; height: 26px; display: grid; place-items: center; }
.m-sel-all { padding: 5px 10px; font: 600 12px 'Inter', sans-serif; }
.m-sel-actions { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; }
.m-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 0 6px;
  border: none;
  border-radius: 10px;
  background: rgba(255,255,255,.05);
  color: rgba(255,255,255,.8);
  font: 600 10.5px 'Inter', sans-serif;
}
.m-act:disabled { opacity: .35; }

/* On its side: one row, the readout then the actions as icons. */
@media (max-height: 500px) {
  .m-sel { flex-direction: row; align-items: center; padding: 4px 8px; gap: 8px; }
  .m-sel-row { flex: 1; min-width: 0; }
  .m-sel-actions { display: flex; gap: 4px; }
  .m-act { width: 40px; padding: 7px 0; font-size: 0; gap: 0; }
}
</style>
