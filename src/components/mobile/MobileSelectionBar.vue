<script setup>
import { useEditorState } from '../../composables/useEditorState.js'
import { useSelectionActions } from '../../composables/useSelectionActions.js'
import Icon from '../ui/Icon.vue'

/**
 * The selection's readout and its actions, in place of the desktop's
 * right-click menu. Always shown with a file. With nothing selected it is ONE
 * row of what works then — Select all, Paste (when there is something to
 * paste), Split at the playhead — and with a selection, the edges and every
 * action (design "small fixes" #3, November 2026). Split cuts at the
 * selection's edges when there is one, else at the playhead.
 *
 * Each edge's time sits between ‹ › nudge buttons: a tap moves that edge one
 * step (about 3 px at the current zoom, a round number — finer when zoomed
 * in), and holding repeats, for the precision a finger cannot reach. A
 * looping selection follows the nudge as it plays.
 */
const { state, hasClipboard, selectAll } = useEditorState()
const { busy, cut, copy, paste, silence, trim, split } = useSelectionActions()

</script>

<template>
  <!-- ONE bar, as on the desktop: every button is always drawn and the ones
       that need a selection are disabled without one. Select all, Paste (with
       something on the clipboard) and Split (at the playhead when nothing is
       selected, else at the selection's edges) work either way. -->
  <div class="m-sel" data-testid="mobile-selection-bar">
    <div class="m-sel-actions">
      <button type="button" class="m-act" :disabled="busy" title="Select all" data-testid="mobile-select-all" @click="selectAll"><Icon name="selectAll" :size="17" />Select</button>
      <button type="button" class="m-act" :disabled="!state.selection || busy" @click="cut"><Icon name="cut" :size="17" />Cut</button>
      <button type="button" class="m-act" :disabled="!state.selection" @click="copy"><Icon name="copy" :size="17" />Copy</button>
      <button type="button" class="m-act" :disabled="!hasClipboard || busy" @click="paste"><Icon name="paste" :size="17" />Paste</button>
      <button type="button" class="m-act" :disabled="!state.selection || busy" @click="silence"><Icon name="silence" :size="17" />Silence</button>
      <button type="button" class="m-act" :disabled="!state.selection || busy" @click="trim"><Icon name="trim" :size="17" />Trim</button>
      <button
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
  background: #01070b; /* #0f1316; */
  flex-shrink: 0;
  padding: 6px 8px 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid #1b2229;
}
.m-sel-actions { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
.m-act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 7px 0 6px;
  border: none;
  border-radius: 10px;
  color: #eaf6f8;
  background: rgba(53,211,230,.12);
  font: 600 10.5px 'Inter', sans-serif;
}
.m-act:disabled { opacity: .35; }

/* On its side: one row, the readout then the actions as icons. */
@media (max-height: 500px) {
  .m-sel { flex-direction: row; align-items: center; padding: 4px 8px; gap: 8px; }
  .m-sel-actions { display: flex; gap: 4px; }
  .m-act { width: 40px; padding: 7px 0; font-size: 0; gap: 0; }
}
</style>
