<script setup>
import { useEditorState } from '../composables/useEditorState.js'
import { CATEGORIES } from '../ui/registry.js'
import Icon from './ui/Icon.vue'

const { state, setActiveTool, hasFile, openCommandPalette } = useEditorState()

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
    <div class="tool-group flex items-center gap-[4px] p-[5px] rounded-[13px] min-w-0 overflow-x-auto" style="background:linear-gradient(180deg, #1a2029, #12161d);box-shadow:inset 0 0 0 1px rgba(255,255,255,.05)">
      <button
        v-for="tool in tools"
        :key="tool.id"
        type="button"
        class="tool-btn"
        :class="{ 'is-active': state.activeTool === tool.id }"
        :disabled="!hasFile"
        :aria-pressed="String(state.activeTool === tool.id)"
        :title="tool.desc"
        @click="setActiveTool(tool.id)"
      >
        <Icon :name="tool.icon" :size="15" class="tool-btn__icon" />
        {{ tool.label }}
      </button>
    </div>
    <!-- Undo/Redo moved to the TopBar, next to Export. This spacer stays: it
         balances the search button on the left so the tool group sits centred
         rather than drifting right. -->
    <div class="flex-1"></div>
  </div>
</template>

<style scoped>
/* Segmented control, styled here rather than through BaseButton.
 *
 * The toolbar is the app's primary navigation and wants a look of its own: a
 * group of chips sharing one recessed tray, where the selected chip lifts out
 * of it. BaseButton's toggle is built for standalone on/off controls, and its
 * selected state is a solid cyan fill — correct for a lone button, but shouting
 * inside a group of four.
 *
 * The selected treatment here matches the accent wash + accent border + bright
 * accent text already used for selected rows in the rail and selected preset
 * cards, so "this one is chosen" looks the same everywhere in the app.
 */
.tool-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-shrink: 0;
  white-space: nowrap;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-soft);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease,
              border-color 0.15s ease, box-shadow 0.15s ease;
}

.tool-btn__icon {
  opacity: 0.8;
  transition: opacity 0.15s ease;
}

.tool-btn:hover:not(:disabled):not(.is-active) {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
}
.tool-btn:hover:not(:disabled) .tool-btn__icon {
  opacity: 1;
}

.tool-btn:active:not(:disabled) {
  transform: translateY(0.5px);
}

.tool-btn.is-active {
  background: linear-gradient(180deg, rgba(53, 211, 230, 0.2), rgba(53, 211, 230, 0.11));
  border-color: rgba(53, 211, 230, 0.45);
  color: var(--color-accent-bright);
  /* Top highlight + outer glow lift the chip off the recessed tray. */
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08),
              0 2px 10px rgba(53, 211, 230, 0.16);
}
.tool-btn.is-active .tool-btn__icon {
  opacity: 1;
}

.tool-btn:focus-visible {
  outline: 2px solid var(--color-accent-bright);
  outline-offset: 2px;
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

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
