<script setup>
import { useEditorState } from '../../composables/useEditorState.js'

const { hasSelection, performSilence, showToast } = useEditorState()

function apply() {
  if (!hasSelection.value) return
  performSilence()
  showToast('Region silenced')
}
</script>

<template>
  <div class="p-5">
    <div class="mb-5">
      <div class="font-heading text-base font-extrabold text-ink">Silence</div>
      <div class="text-xs text-ink-mid font-semibold mt-1">Replace the selected region with silence</div>
    </div>

    <!-- Preview graphic -->
    <div class="bg-bg rounded-[var(--radius-sm)] p-4 mb-4">
      <svg viewBox="0 0 200 60" fill="none" class="w-full h-[52px]">
        <path d="M0 30 Q10 10 20 30 Q30 50 40 30 Q50 15 60 30" stroke="#3ECFB2" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
        <rect x="65" y="28" width="70" height="4" rx="2" fill="#C4C2D4" opacity="0.5"/>
        <line x1="65" y1="10" x2="65" y2="50" stroke="#9B89F5" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.6"/>
        <line x1="135" y1="10" x2="135" y2="50" stroke="#9B89F5" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.6"/>
        <text x="100" y="22" font-size="8" fill="#C4C2D4" text-anchor="middle" font-family="Nunito Sans, sans-serif">silence</text>
        <path d="M140 30 Q150 50 160 30 Q170 10 180 30 Q190 45 200 30" stroke="#3ECFB2" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
      </svg>
      <p class="text-[11px] text-ink-mid font-semibold mt-2 text-center">
        The selected region will be replaced with silence. The clip length stays the same.
      </p>
    </div>

    <div v-if="!hasSelection" class="mt-3 text-xs text-yellow font-bold bg-yellow-lt rounded-lg px-3 py-2">
      ⚠ Make a selection on the waveform first
    </div>

    <button
      class="mt-4 w-full flex items-center justify-center gap-2 bg-mint text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-sm)] border-none cursor-pointer transition-all shadow-[0_3px_0_#2aaa8f] hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[0_1px_0_#2aaa8f] disabled:opacity-40 disabled:cursor-default disabled:translate-y-0"
      :disabled="!hasSelection"
      @click="apply"
    >
      <svg viewBox="0 0 24 24" class="w-3.5 h-3.5 fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      Apply Silence
    </button>
  </div>
</template>
