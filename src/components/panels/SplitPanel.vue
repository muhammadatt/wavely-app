<script setup>
import { ref, computed } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import ApplyAction from '../ui/ApplyAction.vue'

const { state, hasSelection, performSplit, performSplitAtSelectionEdges, showToast } = useEditorState()

const mode = ref('playhead') // 'playhead' | 'selection'

// Splitting at the playhead needs nothing; splitting at the selection edges
// obviously needs a selection. The requirement follows the mode.
const requirementMet = computed(() => mode.value !== 'selection' || hasSelection.value)

function apply() {
  if (mode.value === 'playhead') {
    performSplit()
    showToast('Split at playhead')
  } else {
    if (!hasSelection.value) return
    performSplitAtSelectionEdges()
    showToast('Split at selection edges')
  }
}
</script>

<template>
  <!-- No header: as a rail operation, ContextPanel draws the title block and
       the back chevron from the registry entry. -->
  <div class="font-['Inter']">
    <div class="p-4 flex flex-col gap-2.5">
      <button
        class="text-left px-[14px] py-[13px] rounded-[12px] border cursor-pointer transition-all"
        :style="mode === 'playhead'
          ? 'background:rgba(53,211,230,.12);border-color:rgba(53,211,230,.5)'
          : 'background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.07)'"
        @click="mode = 'playhead'"
      >
        <div class="flex items-start gap-[11px]">
          <span class="relative top-[1px] w-4 h-4 rounded-full border-[1.5px] shrink-0 flex items-center justify-center" style="border-color:rgba(255,255,255,.25)">
            <span v-if="mode === 'playhead'" class="w-2 h-2 rounded-full" style="background:#35d3e6"></span>
          </span>
          <div>
            <div class="text-[12.5px] font-semibold mb-[2px]" :style="{ color: mode === 'playhead' ? '#7fe9f6' : '#eaf6f8' }">Split at playhead</div>
            <div class="text-[10.5px] leading-snug font-medium text-[rgba(255,255,255,.4)]">Cuts at the current playhead position</div>
          </div>
        </div>
      </button>

      <button
        class="text-left px-[14px] py-[13px] rounded-[12px] border cursor-pointer transition-all"
        :style="mode === 'selection'
          ? 'background:rgba(53,211,230,.12);border-color:rgba(53,211,230,.5)'
          : 'background:rgba(255,255,255,.03);border-color:rgba(255,255,255,.07)'"
        @click="mode = 'selection'"
      >
        <div class="flex items-start gap-[11px]">
          <span class="relative top-[1px] w-4 h-4 rounded-full border-[1.5px] shrink-0 flex items-center justify-center" style="border-color:rgba(255,255,255,.25)">
            <span v-if="mode === 'selection'" class="w-2 h-2 rounded-full" style="background:#35d3e6"></span>
          </span>
          <div>
            <div class="text-[12.5px] font-semibold mb-[2px]" :style="{ color: mode === 'selection' ? '#7fe9f6' : '#eaf6f8' }">Split at selection edges</div>
            <div class="text-[10.5px] leading-snug font-medium text-[rgba(255,255,255,.4)]">Creates cuts at both ends of your selection</div>
          </div>
        </div>
      </button>

      <ApplyAction
        class="mt-1"
        :met="requirementMet"
        message="Make a selection to split at its edges"
        label="Apply Split"
        @apply="apply"
      />
    </div>
  </div>
</template>
