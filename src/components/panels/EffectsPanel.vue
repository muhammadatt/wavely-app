<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { normalizeRegion, compressRegion, computePeakCache } from '../../audio/processing.js'
import { getTimelineDuration } from '../../audio/operations.js'

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, updateProcessingProgress, endProcessing, showToast, totalDuration,
} = useEditorState()

// Normalize params
const targetPeak = ref(-1)
// Compression params
const compThreshold = ref(-24)
const compRatio = ref(12)

const openSection = ref('normalize')

function toggleSection(id) {
  openSection.value = openSection.value === id ? null : id
}

async function applyNormalize(useSelection) {
  const start = useSelection && state.selection ? state.selection.start : 0
  const end = useSelection && state.selection ? state.selection.end : totalDuration.value

  if (start >= end) return

  startProcessing('Normalizing...')
  try {
    const ctx = getAudioContext()
    const buffer = await normalizeRegion(
      state.segments, start, end, targetPeak.value,
      ctx, state.currentFile.sampleRate, state.currentFile.channels
    )
    const bufferId = replaceRegion(start, end, buffer)

    // Recompute peak cache for new buffer
    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast('Normalization applied')
  } catch (err) {
    console.error('Normalize failed:', err)
    showToast('Normalization failed')
  } finally {
    endProcessing()
  }
}

async function applyCompression() {
  if (!state.selection) return
  const { start, end } = state.selection

  startProcessing('Compressing...')
  try {
    const ctx = getAudioContext()
    const buffer = await compressRegion(
      state.segments, start, end,
      { threshold: compThreshold.value, ratio: compRatio.value },
      ctx, state.currentFile.sampleRate, state.currentFile.channels
    )
    const bufferId = replaceRegion(start, end, buffer)

    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast('Compression applied')
  } catch (err) {
    console.error('Compression failed:', err)
    showToast('Compression failed')
  } finally {
    endProcessing()
  }
}
</script>

<template>
  <div class="p-5">
    <div class="mb-5">
      <div class="font-heading text-base font-extrabold text-ink">Effects</div>
      <div class="text-xs text-ink-mid font-semibold mt-1">Apply to selection or full track</div>
    </div>

    <!-- Normalize -->
    <div class="border-2 border-border rounded-[var(--radius-sm)] mb-2 overflow-hidden">
      <button
        class="w-full flex items-center gap-3 p-3 bg-transparent border-none cursor-pointer text-left"
        @click="toggleSection('normalize')"
      >
        <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
             :class="openSection === 'normalize' ? 'bg-mint-lt' : 'bg-bg'">
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-mint" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
        </div>
        <div class="flex-1">
          <div class="text-[13px] font-bold text-ink">Normalize</div>
          <div class="text-[10px] text-ink-mid">Balance volume levels</div>
        </div>
        <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform" stroke-width="2"
             :class="{ 'rotate-180': openSection === 'normalize' }">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <div v-if="openSection === 'normalize'" class="px-3 pb-3">
        <div class="flex justify-between items-center mb-2">
          <span class="text-[11px] font-bold text-ink-mid">Target peak</span>
          <span class="text-[11px] font-bold text-ink">{{ targetPeak }} dBFS</span>
        </div>
        <input type="range" min="-12" max="0" v-model.number="targetPeak"
               class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />

        <button
          class="mt-3 w-full flex items-center justify-center gap-2 bg-mint text-white font-heading text-[12px] font-extrabold py-2 rounded-lg border-none cursor-pointer transition-all shadow-[0_2px_0_#2aaa8f] hover:-translate-y-0.5 active:translate-y-0.5"
          @click="applyNormalize(true)"
        >
          <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Apply to Selection
        </button>
        <button
          class="mt-1.5 w-full flex items-center justify-center gap-2 bg-bg text-ink font-heading text-[12px] font-bold py-2 rounded-lg border-none cursor-pointer transition-all hover:bg-border"
          @click="applyNormalize(false)"
        >
          Apply to Full Track
        </button>
      </div>
    </div>

    <!-- Compression -->
    <div class="border-2 border-border rounded-[var(--radius-sm)] mb-2 overflow-hidden">
      <button
        class="w-full flex items-center gap-3 p-3 bg-transparent border-none cursor-pointer text-left"
        @click="toggleSection('compression')"
      >
        <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
             :class="openSection === 'compression' ? 'bg-purple-lt' : 'bg-bg'">
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-purple" stroke-width="2"><path d="M4 14h4v7H4zM10 10h4v11h-4zM16 3h4v18h-4z"/></svg>
        </div>
        <div class="flex-1">
          <div class="text-[13px] font-bold text-ink">Compression</div>
          <div class="text-[10px] text-ink-mid">Reduce dynamic range</div>
        </div>
        <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform" stroke-width="2"
             :class="{ 'rotate-180': openSection === 'compression' }">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <div v-if="openSection === 'compression'" class="px-3 pb-3">
        <div class="flex justify-between items-center mb-2">
          <span class="text-[11px] font-bold text-ink-mid">Threshold</span>
          <span class="text-[11px] font-bold text-ink">{{ compThreshold }} dB</span>
        </div>
        <input type="range" min="-60" max="0" v-model.number="compThreshold"
               class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent mb-3" />

        <div class="flex justify-between items-center mb-2">
          <span class="text-[11px] font-bold text-ink-mid">Ratio</span>
          <span class="text-[11px] font-bold text-ink">{{ compRatio }}:1</span>
        </div>
        <input type="range" min="1" max="20" v-model.number="compRatio"
               class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />

        <div v-if="!hasSelection" class="mt-3 text-xs text-yellow font-bold bg-yellow-lt rounded-lg px-3 py-2">
          ⚠ Make a selection on the waveform first
        </div>

        <button
          class="mt-3 w-full flex items-center justify-center gap-2 bg-mint text-white font-heading text-[12px] font-extrabold py-2 rounded-lg border-none cursor-pointer transition-all shadow-[0_2px_0_#2aaa8f] hover:-translate-y-0.5 active:translate-y-0.5 disabled:opacity-40 disabled:cursor-default disabled:translate-y-0"
          :disabled="!hasSelection"
          @click="applyCompression"
        >
          <svg viewBox="0 0 24 24" class="w-3 h-3 fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Apply Compression
        </button>
      </div>
    </div>

    <!-- Noise Reduction (stub) -->
    <div class="border-2 border-border rounded-[var(--radius-sm)] mb-2 overflow-hidden">
      <button
        class="w-full flex items-center gap-3 p-3 bg-transparent border-none cursor-pointer text-left"
        @click="toggleSection('noise')"
      >
        <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
             :class="openSection === 'noise' ? 'bg-yellow-lt' : 'bg-bg'">
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-yellow" stroke-width="2"><path d="M18.36 5.64a9 9 0 11-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
        </div>
        <div class="flex-1">
          <div class="text-[13px] font-bold text-ink">Noise Reduction</div>
          <div class="text-[10px] text-ink-mid">Remove background noise</div>
        </div>
        <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform" stroke-width="2"
             :class="{ 'rotate-180': openSection === 'noise' }">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      <div v-if="openSection === 'noise'" class="px-3 pb-3">
        <div class="bg-yellow-lt rounded-lg px-3 py-2 text-xs text-yellow font-bold">
          Coming soon — requires RNNoise WASM integration
        </div>
      </div>
    </div>
  </div>
</template>
