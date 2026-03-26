<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'

const { hasSelection, performTrimToSelection, performTrimBefore, performTrimAfter, showToast } = useEditorState()

const mode = ref('to-selection')

function apply() {
  if (!hasSelection.value) return
  switch (mode.value) {
    case 'to-selection':
      performTrimToSelection()
      showToast('Trimmed to selection')
      break
    case 'before':
      performTrimBefore()
      showToast('Removed before selection')
      break
    case 'after':
      performTrimAfter()
      showToast('Removed after selection')
      break
  }
}

const options = [
  { id: 'to-selection', label: 'Trim to selection', desc: "Keep only what's selected, remove the rest" },
  { id: 'before', label: 'Remove before selection', desc: 'Delete everything to the left of the selection' },
  { id: 'after', label: 'Remove after selection', desc: 'Delete everything to the right of the selection' },
]
</script>

<template>
  <div>
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Trim</div>
      <div class="text-[11px] text-ink-lt font-bold">Remove audio outside or inside your selection</div>
    </div>

    <div class="p-3 flex flex-col gap-2">
      <label
        v-for="opt in options"
        :key="opt.id"
        class="flex items-start gap-2.5 px-[13px] py-[11px] rounded-[var(--radius-md)] border-2 cursor-pointer transition-all hover:scale-[1.02]"
        :class="mode === opt.id ? 'border-accent bg-accent-lt' : 'border-border bg-bg hover:border-purple'"
        @click="mode = opt.id"
      >
        <div class="w-4 h-4 rounded-full border-[2.5px] mt-[1px] shrink-0 flex items-center justify-center transition-all"
             :class="mode === opt.id ? 'border-accent bg-accent shadow-[inset_0_0_0_3px_white]' : 'border-ink-lt'">
        </div>
        <div>
          <div class="font-heading text-[12px] font-bold text-ink mb-[2px]" :class="{ 'text-accent-dk': mode === opt.id }">{{ opt.label }}</div>
          <div class="text-[11px] text-ink-lt font-semibold leading-snug">{{ opt.desc }}</div>
        </div>
      </label>

      <div v-if="!hasSelection" class="text-[11px] text-ink-mid font-bold bg-yellow-lt border-2 border-yellow rounded-[var(--radius-md)] px-3 py-2.5 text-center leading-relaxed">
        Make a selection on the waveform first
      </div>

      <button
        class="mt-1 w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
        :disabled="!hasSelection"
        @click="apply"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Trim
      </button>
    </div>
  </div>
</template>
