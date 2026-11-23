<script setup>
import { useEditorState } from '../../composables/useEditorState.js'
import { useSelectionActions } from '../../composables/useSelectionActions.js'
import Icon from '../ui/Icon.vue'
import { DEV_TUNING_PANELS } from '../../devFlags.js'

/**
 * The selection's actions, in place of the desktop's right-click menu. Always
 * shown with a file, as one row: every button is drawn and the ones that need
 * a selection are disabled without one. The first button toggles — Select
 * (all) with nothing selected, Clear with a selection — since there is no ✕.
 * Paste (with something on the clipboard) and Split work either way; Split
 * cuts at the selection's edges when there is one, else at the playhead.
 * The edges and their nudges live in MobileSelectionReadout.
 */
const { state, hasClipboard, selectAll, clearSelection } = useEditorState()
const { busy, cut, copy, paste, silence, trim, split } = useSelectionActions()
</script>

<template>
  <!-- ONE bar, as on the desktop: see the header comment. -->
  <div class="m-sel" data-testid="mobile-selection-bar">
    <div class="m-sel-actions" :style="{ '--m-act-cols': DEV_TUNING_PANELS ? 7 : 6 }">
      <button
        v-if="state.selection"
        type="button"
        class="m-act"
        title="Clear the selection"
        data-testid="mobile-clear-selection"
        @click="clearSelection"
      ><Icon name="deselect" :size="17" />Clear</button>
      <button
        v-else
        type="button"
        class="m-act"
        :disabled="busy"
        title="Select all"
        data-testid="mobile-select-all"
        @click="selectAll"
      ><Icon name="selectAll" :size="17" />Select</button>
      <button type="button" class="m-act" :disabled="!state.selection || busy" @click="cut"><Icon name="cut" :size="17" />Cut</button>
      <button type="button" class="m-act" :disabled="!state.selection" @click="copy"><Icon name="copy" :size="17" />Copy</button>
      <button type="button" class="m-act" :disabled="!hasClipboard || busy" @click="paste"><Icon name="paste" :size="17" />Paste</button>
      <button type="button" class="m-act" :disabled="!state.selection || busy" @click="silence"><Icon name="silence" :size="17" />Silence</button>
      <button type="button" class="m-act" :disabled="!state.selection || busy" @click="trim"><Icon name="trim" :size="17" />Trim</button>
      <!-- Split is dev-only while the split / regions / markers work is on
           its own branch (the registry's Split is gated the same way). -->
      <button
        v-if="DEV_TUNING_PANELS"
        type="button"
        class="m-act"
        :disabled="busy"
        :title="state.selection ? 'Split at the selection’s edges' : 'Split at the playhead'"
        data-testid="mobile-split"
        @click="split"
      ><Icon name="split" :size="17" />Split</button>
    </div>
  </div>
</template>

<style scoped>
.m-sel {
  background: var(--mob-bar-bg);
  flex-shrink: 0;
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--mob-bar-border);
}
.m-sel-actions { display: grid; grid-template-columns: repeat(var(--m-act-cols, 7), 1fr); gap: 5px; }
.m-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 0 6px;
  border: none;
  border-radius: 10px;
  color: #eaf6f8;
  background: var(--mob-accent-wash);
  font: 600 10.5px 'Inter', sans-serif;
}
.m-act:disabled { opacity: .35; }

/* On its side: the actions as one row of icons. */
@media (max-height: 500px) {
  .m-sel { flex-direction: row; align-items: center; padding: 4px 8px; gap: 8px; }
  .m-sel-actions { display: flex; gap: 4px; }
  .m-act { width: 40px; padding: 7px 0; font-size: 0; gap: 0; }
}
</style>
