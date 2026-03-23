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
  <div class="p-5">
    <div class="mb-5">
      <div class="font-heading text-base font-extrabold text-ink">Fade</div>
      <div class="text-xs text-ink-mid font-semibold mt-1">Shape the volume curve at the selection edges</div>
    </div>

    <!-- Fade type -->
    <div class="mb-4">
      <div class="text-[11px] font-bold text-ink-mid mb-2">Type</div>
      <div class="grid grid-cols-3 gap-1.5">
        <button
          v-for="ft in fadeTypes"
          :key="ft.id"
          class="flex flex-col items-center gap-1 p-2 rounded-lg border-2 text-[10px] font-bold cursor-pointer transition-all"
          :class="fadeType === ft.id ? 'border-accent bg-accent-lt text-accent' : 'border-border text-ink-mid hover:border-ink-lt'"
          @click="fadeType = ft.id"
        >
          <svg viewBox="0 0 48 24" fill="none" class="w-full h-5">
            <path :d="ft.path" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          {{ ft.label }}
        </button>
      </div>
    </div>

    <!-- Curve shape -->
    <div class="mb-4">
      <div class="text-[11px] font-bold text-ink-mid mb-2">Curve</div>
      <div class="grid grid-cols-3 gap-1.5">
        <button
          v-for="ct in curveTypes"
          :key="ct.id"
          class="flex flex-col items-center gap-1 p-2 rounded-lg border-2 text-[10px] font-bold cursor-pointer transition-all"
          :class="curveType === ct.id ? 'border-accent bg-accent-lt text-accent' : 'border-border text-ink-mid hover:border-ink-lt'"
          @click="curveType = ct.id"
        >
          <svg viewBox="0 0 48 24" fill="none" class="w-full h-5">
            <path :d="ct.path" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          {{ ct.label }}
        </button>
      </div>
    </div>

    <!-- Duration slider -->
    <div class="mb-4">
      <div class="flex justify-between items-center mb-2">
        <span class="text-[11px] font-bold text-ink-mid">Duration</span>
        <span class="text-[11px] font-bold text-ink">{{ durationDisplay() }}</span>
      </div>
      <input
        type="range"
        min="1"
        max="100"
        v-model.number="duration"
        class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent"
      />
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
      Apply Fade
    </button>
  </div>
</template>
