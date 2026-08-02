<script setup>
import { computed } from 'vue'
import { useEditorState } from '../composables/useEditorState.js'
import { useOperationDispatch } from '../composables/useOperationDispatch.js'
import { getCategory, getOperation } from '../ui/registry.js'
import OperationList from './ui/OperationList.vue'
import PanelHeader from './ui/PanelHeader.vue'
import Icon from './ui/Icon.vue'

/**
 * The right-hand rail.
 *
 * Two levels: a category list, and the detail view for one operation. Which one
 * shows is decided entirely by the registry — there is no per-category branch
 * here any more, and no v-if chain to keep in sync with the toolbar.
 *
 * Categories carrying a bespoke `panel` (Split, Presets) render it directly and
 * skip the list level; they aren't lists of operations.
 */
const { state, closeRail, setRailOperation } = useEditorState()
const { dispatch, isDisabled } = useOperationDispatch()

const category = computed(() => getCategory(state.activeTool))
const operation = computed(() => (state.railOperation ? getOperation(state.railOperation) : null))
</script>

<template>
  <div
    class="w-[280px] shrink-0 relative border-l border-border-1 overflow-y-auto"
    style="background:linear-gradient(180deg,#141922,#0e1116)"
  >
    <button
      class="panel-close absolute top-[14px] right-[14px] z-10 w-6 h-6 rounded-[7px] flex items-center justify-center cursor-pointer"
      title="Close panel (Esc)"
      aria-label="Close panel"
      @click="closeRail"
    >
      <Icon name="close" :size="12" :stroke-width="2.5" />
    </button>

    <template v-if="category">
      <!-- Bespoke panel: owns its own header and body -->
      <component v-if="category.panel" :is="category.panel" />

      <!-- Detail level -->
      <template v-else-if="operation">
        <PanelHeader
          :title="operation.label"
          :desc="operation.desc"
          back
          :back-label="category.label"
          @back="setRailOperation(null)"
        />
        <component :is="operation.component" />
      </template>

      <!-- List level -->
      <template v-else>
        <PanelHeader :title="category.label" :desc="category.desc" />
        <OperationList
          :category-id="category.id"
          :is-disabled="isDisabled"
          @select="dispatch"
        />
      </template>
    </template>
  </div>
</template>

<style scoped>
.panel-close {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.09);
  color: rgba(255, 255, 255, 0.55);
  transition: background-color 0.15s ease, color 0.15s ease;
}
.panel-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
}
.panel-close:focus-visible {
  outline: 2px solid #7fe9f6;
  outline-offset: 2px;
}
</style>
