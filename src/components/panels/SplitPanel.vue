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
  <div class="p-5">
    <div class="mb-5">
      <div class="font-heading text-base font-extrabold text-ink">Split</div>
      <div class="text-xs text-ink-mid font-semibold mt-1">Divide the audio into two separate clips</div>
    </div>

    <div class="flex flex-col gap-2">
      <label
        class="flex items-start gap-3 p-3 rounded-[var(--radius-sm)] border-2 cursor-pointer transition-all"
        :class="mode === 'playhead' ? 'border-accent bg-accent-lt' : 'border-border hover:border-ink-lt'"
        @click="mode = 'playhead'"
      >
        <div class="w-4 h-4 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center"
             :class="mode === 'playhead' ? 'border-accent' : 'border-ink-lt'">
          <div v-if="mode === 'playhead'" class="w-2 h-2 rounded-full bg-accent"></div>
        </div>
        <div>
          <div class="text-[13px] font-bold text-ink">Split at playhead</div>
          <div class="text-[11px] text-ink-mid mt-0.5">Cuts at the current playhead position</div>
        </div>
      </label>

      <label
        class="flex items-start gap-3 p-3 rounded-[var(--radius-sm)] border-2 cursor-pointer transition-all"
        :class="mode === 'selection' ? 'border-accent bg-accent-lt' : 'border-border hover:border-ink-lt'"
        @click="mode = 'selection'"
      >
        <div class="w-4 h-4 rounded-full border-2 mt-0.5 shrink-0 flex items-center justify-center"
             :class="mode === 'selection' ? 'border-accent' : 'border-ink-lt'">
          <div v-if="mode === 'selection'" class="w-2 h-2 rounded-full bg-accent"></div>
        </div>
        <div>
          <div class="text-[13px] font-bold text-ink">Split at selection edges</div>
          <div class="text-[11px] text-ink-mid mt-0.5">Creates cuts at both ends of your selection</div>
        </div>
      </label>
    </div>

    <div v-if="mode === 'selection' && !hasSelection" class="mt-3 text-xs text-yellow font-bold bg-yellow-lt rounded-lg px-3 py-2">
      ⚠ Make a selection on the waveform first
    </div>

    <button
      class="mt-4 w-full flex items-center justify-center gap-2 bg-mint text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-sm)] border-none cursor-pointer transition-all shadow-[0_3px_0_#2aaa8f] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[0_1px_0_#2aaa8f] disabled:opacity-40 disabled:cursor-default disabled:translate-y-0"
      :disabled="mode === 'selection' && !hasSelection"
      @click="apply"
    >
      <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      Apply Split
    </button>
  </div>
</template>
