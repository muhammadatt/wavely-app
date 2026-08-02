<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import { CATEGORIES } from '../ui/registry.js'
import BaseButton from './ui/BaseButton.vue'
import Icon from './ui/Icon.vue'

const { state, setActiveTool, hasFile, undo, redo, canUndo, canRedo, openCommandPalette } = useEditorState()

// The category list lives in the registry, so the toolbar and the rail can no
// longer disagree about which tools exist.
const tools = CATEGORIES
</script>

<template>
  <div class="h-[60px] flex items-center gap-3 px-5 shrink-0 border-b border-[rgba(255,255,255,.06)]" style="background:linear-gradient(180deg,#12161b,#0e1216)">
    <!-- Search is the escape hatch from the category hierarchy: as the number
         of operations grows, this is how you reach one without knowing which
         category it lives in. -->
    <div class="flex-1 min-w-0 flex items-center">
      <button
        class="palette-trigger flex items-center gap-2 pl-[10px] pr-2 py-[7px] rounded-[10px] cursor-pointer max-w-[210px]"
        :disabled="!hasFile"
        title="Search operations (Ctrl+K)"
        @click="openCommandPalette"
      >
        <Icon name="search" :size="13" />
        <span class="text-[11.5px] font-semibold truncate">Search…</span>
        <kbd class="ml-auto shrink-0 font-mono text-[9.5px] font-bold px-[5px] py-[2px] rounded-[5px] tracking-[.04em]">Ctrl K</kbd>
      </button>
    </div>
    <!-- min-w-0 + scroll: the tool group gives up centring before it collides
         with the zoom controls on a narrow window. -->
    <div class="tool-group flex items-center gap-[4px] p-[5px] rounded-[13px] min-w-0 overflow-x-auto" style="background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
      <BaseButton
        v-for="tool in tools"
        :key="tool.id"
        size="md" :pill="false" toggle
        :active="state.activeTool === tool.id"
        :disabled="!hasFile"
        class="whitespace-nowrap shrink-0"
        @click="setActiveTool(tool.id)"
      >
        <Icon :name="tool.icon" :size="15" />
        {{ tool.label }}
      </BaseButton>
    </div>
    <!-- No min-w-0 here on purpose: this side must never shrink below its own
         content, or its basis-0 box collapses and the buttons spill leftward
         over the tool group. -->
    <div class="flex-1 flex justify-end gap-2">
      <BaseButton
        size="sm" color="ghost" :pill="false"
        :disabled="!canUndo"
        @click="undo"
        title="Undo (Ctrl+Z)"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/></svg>
        Undo
      </BaseButton>
      <BaseButton
        size="sm" color="ghost" :pill="false"
        :disabled="!canRedo"
        @click="redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h4"/></svg>
        Redo
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.palette-trigger {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.45);
  transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.palette-trigger:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.07);
  border-color: rgba(53, 211, 230, 0.4);
  color: #7fe9f6;
}
.palette-trigger:disabled {
  opacity: 0.4;
  cursor: default;
}
.palette-trigger:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}
.palette-trigger kbd {
  background: rgba(255, 255, 255, 0.07);
  color: rgba(255, 255, 255, 0.4);
}

.tool-group {
  scrollbar-width: none;
}
.tool-group::-webkit-scrollbar {
  display: none;
}
</style>
