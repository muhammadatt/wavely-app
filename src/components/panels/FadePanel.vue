<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'

const { hasSelection, showToast } = useEditorState()

const fadeType = ref('in')
const curveType = ref('linear')
const duration = ref(20) // 0-100 slider, maps to actual seconds

const fadeTypes = [
  { id: 'in', label: 'Fade In', path: 'M2 22 Q24 22 46 2' },
  { id: 'out', label: 'Fade Out', path: 'M2 2 Q24 22 46 22' },
  { id: 'cross', label: 'Crossfade', path: 'M2 22 Q24 12 46 2' },
]

const curveTypes = [
  { id: 'linear', label: 'Linear', path: 'M2 22 C12 22 36 2 46 2' },
  { id: 'expo', label: 'Expo', path: 'M2 22 C2 22 10 2 46 2' },
  { id: 's-curve', label: 'S-Curve', path: 'M2 22 C16 22 32 2 46 2' },
]

function durationDisplay() {
  return (duration.value / 20).toFixed(1) + ' s'
}

function apply() {
  showToast('Fade applied (coming in production)')
}
</script>

<template>
  <div>
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Fade</div>
      <div class="text-[11px] text-ink-lt font-bold">Shape the volume curve at the selection edges</div>
    </div>

    <div class="p-3 flex flex-col gap-3">
      <!-- Fade type -->
      <div>
        <div class="text-[11px] font-bold text-ink-mid mb-2">Type</div>
        <div class="flex gap-1.5">
          <button
            v-for="ft in fadeTypes"
            :key="ft.id"
            class="flex-1 flex flex-col items-center gap-[5px] py-2.5 px-1 rounded-[var(--radius-md)] border-2 text-[10px] font-bold cursor-pointer transition-all hover:scale-[1.04]"
            :class="fadeType === ft.id ? 'border-accent bg-accent-lt text-accent' : 'border-border bg-bg text-ink-mid hover:border-purple hover:text-ink'"
            @click="fadeType = ft.id"
          >
            <svg viewBox="0 0 48 24" fill="none" class="w-9 h-[18px]">
              <path :d="ft.path" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            {{ ft.label }}
          </button>
        </div>
      </div>

      <!-- Curve shape -->
      <div>
        <div class="text-[11px] font-bold text-ink-mid mb-2">Curve</div>
        <div class="flex gap-1.5">
          <button
            v-for="ct in curveTypes"
            :key="ct.id"
            class="flex-1 flex flex-col items-center gap-[5px] py-2.5 px-1 rounded-[var(--radius-md)] border-2 text-[10px] font-bold cursor-pointer transition-all hover:scale-[1.04]"
            :class="curveType === ct.id ? 'border-accent bg-accent-lt text-accent' : 'border-border bg-bg text-ink-mid hover:border-purple hover:text-ink'"
            @click="curveType = ct.id"
          >
            <svg viewBox="0 0 48 24" fill="none" class="w-9 h-[18px]">
              <path :d="ct.path" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
            {{ ct.label }}
          </button>
        </div>
      </div>

      <!-- Duration slider -->
      <div>
        <div class="flex justify-between items-center mb-1.5">
          <span class="text-[11px] font-bold text-ink-mid">Duration</span>
          <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ durationDisplay() }}</span>
        </div>
        <input
          type="range"
          min="1"
          max="100"
          v-model.number="duration"
          class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent"
        />
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
        Apply Fade
      </button>
    </div>
  </div>
</template>
