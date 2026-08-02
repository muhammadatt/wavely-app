<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import BaseButton from '../ui/BaseButton.vue'
import RequirementNotice from '../ui/RequirementNotice.vue'

const { state, hasSelection, performSplit, performSplitAtSelectionEdges, showToast } = useEditorState()

const mode = ref('playhead') // 'playhead' | 'selection'

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
  <div class="font-['Inter']">
    <!-- Panel header -->
    <div class="px-5 pt-5 pb-[14px] border-b border-[rgba(255,255,255,.06)]">
      <div class="text-[15px] font-bold text-[#eaf6f8]">Split</div>
      <div class="mt-[4px] text-[11.5px] leading-[1.4] text-[rgba(255,255,255,.42)]">Divide the audio into two separate clips</div>
    </div>

    <!-- Panel body -->
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

      <RequirementNotice
        v-if="mode === 'selection'"
        :met="hasSelection"
        :reserve-space="false"
      />

      <BaseButton
        class="mt-1" size="lg" block
        :disabled="mode === 'selection' && !hasSelection"
        @click="apply"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Split
      </BaseButton>
    </div>
  </div>
</template>
