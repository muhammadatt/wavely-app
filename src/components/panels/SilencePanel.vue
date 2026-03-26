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
  <div>
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Silence</div>
      <div class="text-[11px] text-ink-lt font-bold">Replace the selected region with silence</div>
    </div>

    <div class="p-3 flex flex-col gap-2.5">
      <!-- Preview graphic -->
      <div class="bg-bg border-2 border-border rounded-[var(--radius-md)] p-3">
        <svg viewBox="0 0 200 60" fill="none" class="w-full h-[52px]">
          <path d="M0 30 Q10 10 20 30 Q30 50 40 30 Q50 15 60 30" stroke="#3ECFB2" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
          <rect x="65" y="28" width="70" height="4" rx="2" fill="#C4C2D4" opacity="0.5"/>
          <line x1="65" y1="10" x2="65" y2="50" stroke="#9B89F5" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.6"/>
          <line x1="135" y1="10" x2="135" y2="50" stroke="#9B89F5" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.6"/>
          <text x="100" y="22" font-size="8" fill="#C4C2D4" text-anchor="middle" font-family="Nunito Sans, sans-serif">silence</text>
          <path d="M140 30 Q150 50 160 30 Q170 10 180 30 Q190 45 200 30" stroke="#3ECFB2" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
        </svg>
        <p class="text-[11px] text-ink-mid font-semibold mt-2 text-center leading-relaxed">
          The selected region will be replaced with silence. The clip length stays the same.
        </p>
      </div>

      <div v-if="!hasSelection" class="text-[11px] text-ink-mid font-bold bg-yellow-lt border-2 border-yellow rounded-[var(--radius-md)] px-3 py-2.5 text-center leading-relaxed">
        Make a selection on the waveform first
      </div>

      <button
        class="mt-1 w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
        :disabled="!hasSelection"
        @click="apply"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Silence
      </button>
    </div>
  </div>
</template>
