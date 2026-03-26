<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'

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
  <div>
    <!-- Panel header -->
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Split</div>
      <div class="text-[11px] text-ink-lt font-bold">Divide the audio into two separate clips</div>
    </div>

    <!-- Panel body -->
    <div class="p-3 flex flex-col gap-2">
      <label
        class="flex items-start gap-2.5 px-[13px] py-[11px] rounded-[var(--radius-md)] border-2 cursor-pointer transition-all hover:scale-[1.02]"
        :class="mode === 'playhead' ? 'border-accent bg-accent-lt' : 'border-border bg-bg hover:border-purple'"
        @click="mode = 'playhead'"
      >
        <div class="w-4 h-4 rounded-full border-[2.5px] mt-[1px] shrink-0 flex items-center justify-center transition-all"
             :class="mode === 'playhead' ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_white]' : 'border-ink-lt'">
        </div>
        <div>
          <div class="font-heading text-[12px] font-bold text-ink mb-[2px]" :class="{ 'text-accent-dk': mode === 'playhead' }">Split at playhead</div>
          <div class="text-[11px] text-ink-lt font-semibold leading-snug">Cuts at the current playhead position</div>
        </div>
      </label>

      <label
        class="flex items-start gap-2.5 px-[13px] py-[11px] rounded-[var(--radius-md)] border-2 cursor-pointer transition-all hover:scale-[1.02]"
        :class="mode === 'selection' ? 'border-accent bg-accent-lt' : 'border-border bg-bg hover:border-purple'"
        @click="mode = 'selection'"
      >
        <div class="w-4 h-4 rounded-full border-[2.5px] mt-[1px] shrink-0 flex items-center justify-center transition-all"
             :class="mode === 'selection' ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_white]' : 'border-ink-lt'">
        </div>
        <div>
          <div class="font-heading text-[12px] font-bold text-ink mb-[2px]" :class="{ 'text-accent-dk': mode === 'selection' }">Split at selection edges</div>
          <div class="text-[11px] text-ink-lt font-semibold leading-snug">Creates cuts at both ends of your selection</div>
        </div>
      </label>

      <div v-if="mode === 'selection' && !hasSelection" class="text-[11px] text-ink-mid font-bold bg-yellow-lt border-2 border-yellow rounded-[var(--radius-md)] px-3 py-2.5 text-center leading-relaxed">
        Make a selection on the waveform first
      </div>

      <button
        class="mt-1 w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
        :disabled="mode === 'selection' && !hasSelection"
        @click="apply"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Split
      </button>
    </div>
  </div>
</template>
