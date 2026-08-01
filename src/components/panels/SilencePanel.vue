<script setup>
import { useEditorState } from '../../composables/useEditorState.js'
import BaseButton from '../ui/BaseButton.vue'

const { hasSelection, performSilence, showToast } = useEditorState()

function apply() {
  if (!hasSelection.value) return
  performSilence()
  showToast('Region silenced')
}
</script>

<template>
  <div class="font-['Inter']">
    <!-- Header lives in EditPanel, which owns the Trim/Silence/Fade/Volume group -->
    <div class="p-4 flex flex-col gap-[10px]">
      <!-- Preview graphic -->
      <div class="rounded-[12px] p-3" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <svg viewBox="0 0 200 60" fill="none" class="w-full h-[52px]">
          <path d="M0 30 Q10 10 20 30 Q30 50 40 30 Q50 15 60 30" stroke="#5df0b0" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
          <rect x="65" y="28" width="70" height="4" rx="2" fill="rgba(255,255,255,.25)"/>
          <line x1="65" y1="10" x2="65" y2="50" stroke="#35d3e6" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.6"/>
          <line x1="135" y1="10" x2="135" y2="50" stroke="#35d3e6" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.6"/>
          <text x="100" y="22" font-size="8" fill="rgba(255,255,255,.4)" text-anchor="middle" font-family="JetBrains Mono, monospace">silence</text>
          <path d="M140 30 Q150 50 160 30 Q170 10 180 30 Q190 45 200 30" stroke="#5df0b0" stroke-width="1.5" stroke-linecap="round" opacity="0.8"/>
        </svg>
        <p class="text-[11px] font-medium mt-2 text-center leading-relaxed text-[rgba(255,255,255,.42)]">
          The selected region will be replaced with silence. The clip length stays the same.
        </p>
      </div>

      <div v-if="!hasSelection" class="text-[11px] font-semibold rounded-[12px] px-3 py-[10px] text-center leading-relaxed" style="color:#e0b84a;background:rgba(224,184,74,.08);border:1px solid rgba(224,184,74,.32)">
        Make a selection on the waveform first
      </div>

      <BaseButton
        class="mt-1" size="lg" block
        :disabled="!hasSelection"
        @click="apply"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Silence
      </BaseButton>
    </div>
  </div>
</template>
