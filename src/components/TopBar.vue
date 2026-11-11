<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import { useHeaderTools } from '../composables/useHeaderTools.js'
import Icon from './ui/Icon.vue'
import AccountMenu from './AccountMenu.vue'
import FloatingToolbar from './FloatingToolbar.vue'

const { undo, redo, canUndo, canRedo } = useEditorState()

// From 1100 px the category toolbar lives here, centred between the logo and
// the actions, and its own row goes — the header's middle and that row's sides
// were both empty. Narrower and compact viewports keep two rows.
const headerTools = useHeaderTools()
</script>

<template>
  <!-- The header: brand, the tools, history and the account. File actions
       (Files, Save) live on the tab row, beside the files they act on. -->
  <div
    class="h-[56px] compact:h-[44px] flex items-center px-5 compact:px-2 gap-[13px] compact:gap-2 shrink-0 z-10"
    style="background:var(--color-chrome)"
  >
    <!-- Logo. flex-1 from a zero basis on both sides keeps the tools centred
         on the window; min-w-fit stops either end shrinking under its own
         content, so on a tight window the tools give way (they scroll), never
         the actions. -->
    <div class="flex-1 basis-0 min-w-fit flex items-center">
      <img src="/crisp-fm-logo.png" alt="crisp.fm" class="h-[26px] compact:h-[20px] max-sm:h-[17px] w-auto select-none shrink-0" draggable="false" />
    </div>

    <FloatingToolbar v-if="headerTools" inline class="shrink min-w-0" />

    <div class="flex-1 basis-0 min-w-fit flex items-center justify-end gap-2 compact:gap-1">
      <!-- History. One outlined group, the two halves split by a hairline:
           icon-only, since the arrows are unambiguous, and joined so the pair
           reads as one control rather than two loose glyphs. -->
      <div class="tb-history flex items-stretch shrink-0" role="group" aria-label="History">
        <button
          class="tb-icon"
          :disabled="!canUndo"
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
          @click="undo"
        ><Icon name="undo" :size="16" /></button>
        <button
          class="tb-icon"
          :disabled="!canRedo"
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
          @click="redo"
        ><Icon name="redo" :size="16" /></button>
      </div>

      <AccountMenu />
    </div>
  </div>
</template>

<style scoped>
.tb-history {
  height: 34px;
  border-radius: 10px;
  background: rgba(255, 255, 255, .03);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .1);
  overflow: hidden;
}
.tb-icon {
  cursor: pointer;
  width: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-soft);
  transition: background-color .12s, color .12s;
}
.tb-icon + .tb-icon { box-shadow: inset 1px 0 0 rgba(255, 255, 255, .1); }
.tb-icon:hover:not(:disabled) { background: rgba(255, 255, 255, .07); color: var(--color-text); }
.tb-icon:disabled { color: rgba(255, 255, 255, .25); cursor: default; }
.tb-icon:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -2px; }
</style>
