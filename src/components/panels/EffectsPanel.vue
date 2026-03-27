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
// Noise Reduction params
const noiseStrength = ref(50)
const noiseSensitivity = ref(60)
// Remove Silence params
const silenceThreshold = ref(-40)
const silenceMinLength = ref(5)

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
  <div>
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Effects</div>
      <div class="text-[11px] text-ink-lt font-bold">Apply to selection or full track</div>
    </div>

    <div class="p-3 flex flex-col gap-1.5">
      <!-- Normalize -->
      <div class="border-2 border-border rounded-[var(--radius-md)] overflow-hidden transition-all"
           :class="{ 'border-accent': openSection === 'normalize' }">
        <button
          class="w-full flex items-center gap-2.5 px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('normalize')"
        >
          <div class="w-[34px] h-[34px] rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors"
               :class="openSection === 'normalize' ? 'bg-accent-lt' : 'bg-bg'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :class="openSection === 'normalize' ? 'stroke-accent' : 'stroke-ink-mid'" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <div class="flex-1">
            <div class="font-heading text-[13px] font-extrabold text-ink">Normalize</div>
            <div class="text-[11px] text-ink-lt font-semibold mt-[1px]">Balance volume levels</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform shrink-0" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'normalize' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'normalize'" class="px-[13px] pb-[13px] flex flex-col gap-2.5">
          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Target peak</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ targetPeak }} dBFS</span>
            </div>
            <input type="range" min="-12" max="0" v-model.number="targetPeak"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>

          <button
            class="w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
            :disabled="!hasSelection"
            @click="applyNormalize(true)"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Apply Normalize
          </button>

        </div>
      </div>

      <!-- Compression -->
      <div class="border-2 border-border rounded-[var(--radius-md)] overflow-hidden transition-all"
           :class="{ 'border-accent': openSection === 'compression' }">
        <button
          class="w-full flex items-center gap-2.5 px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('compression')"
        >
          <div class="w-[34px] h-[34px] rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors"
               :class="openSection === 'compression' ? 'bg-accent-lt' : 'bg-bg'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :class="openSection === 'compression' ? 'stroke-accent' : 'stroke-ink-mid'" stroke-width="2"><path d="M4 14h4v7H4zM10 10h4v11h-4zM16 3h4v18h-4z"/></svg>
          </div>
          <div class="flex-1">
            <div class="font-heading text-[13px] font-extrabold text-ink">Compression</div>
            <div class="text-[11px] text-ink-lt font-semibold mt-[1px]">Reduce dynamic range</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform shrink-0" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'compression' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'compression'" class="px-[13px] pb-[13px] flex flex-col gap-2.5">
          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Threshold</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ compThreshold }} dB</span>
            </div>
            <input type="range" min="-60" max="0" v-model.number="compThreshold"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>

          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Ratio</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ compRatio }}:1</span>
            </div>
            <input type="range" min="1" max="20" v-model.number="compRatio"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>

          <button
            class="w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
            :disabled="!hasSelection"
            @click="applyCompression"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Apply Compression
          </button>
        </div>
      </div>

      <!-- Noise Reduction -->
      <div class="border-2 border-border rounded-[var(--radius-md)] overflow-hidden transition-all"
           :class="{ 'border-accent': openSection === 'noise' }">
        <button
          class="w-full flex items-center gap-2.5 px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('noise')"
        >
          <div class="w-[34px] h-[34px] rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors"
               :class="openSection === 'noise' ? 'bg-accent-lt' : 'bg-bg'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :class="openSection === 'noise' ? 'stroke-accent' : 'stroke-ink-mid'" stroke-width="2"><path d="M12 2a3 3 0 013 3v7a3 3 0 01-6 0V5a3 3 0 013-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3M8 23h8"/></svg>
          </div>
          <div class="flex-1">
            <div class="font-heading text-[13px] font-extrabold text-ink">Noise Reduction</div>
            <div class="text-[11px] text-ink-lt font-semibold mt-[1px]">Remove background noise</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform shrink-0" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'noise' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'noise'" class="px-[13px] pb-[13px] flex flex-col gap-2.5">
          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Strength</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ noiseStrength < 34 ? 'Low' : noiseStrength < 67 ? 'Medium' : 'High' }}</span>
            </div>
            <input type="range" min="0" max="100" v-model.number="noiseStrength"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Sensitivity</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ noiseSensitivity }}%</span>
            </div>
            <input type="range" min="0" max="100" v-model.number="noiseSensitivity"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>
          <button
            class="w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
            :disabled="!hasSelection"
            @click="showToast('Noise reduction requires RNNoise WASM — coming soon')"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Apply Noise Reduction
          </button>
        </div>
      </div>

      <!-- Remove Silence -->
      <div class="border-2 border-border rounded-[var(--radius-md)] overflow-hidden transition-all"
           :class="{ 'border-accent': openSection === 'trim-silence' }">
        <button
          class="w-full flex items-center gap-2.5 px-[13px] py-3 bg-transparent border-none cursor-pointer text-left select-none"
          @click="toggleSection('trim-silence')"
        >
          <div class="w-[34px] h-[34px] rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 transition-colors"
               :class="openSection === 'trim-silence' ? 'bg-accent-lt' : 'bg-bg'">
            <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none" :class="openSection === 'trim-silence' ? 'stroke-accent' : 'stroke-ink-mid'" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
          </div>
          <div class="flex-1">
            <div class="font-heading text-[13px] font-extrabold text-ink">Remove Silence</div>
            <div class="text-[11px] text-ink-lt font-semibold mt-[1px]">Remove quiet sections</div>
          </div>
          <svg viewBox="0 0 24 24" class="w-4 h-4 fill-none stroke-ink-lt transition-transform shrink-0" stroke-width="2.5"
               :class="{ 'rotate-180': openSection === 'trim-silence' }">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>

        <div v-if="openSection === 'trim-silence'" class="px-[13px] pb-[13px] flex flex-col gap-2.5">
          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Silence threshold</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ silenceThreshold }} dB</span>
            </div>
            <input type="range" min="-60" max="-10" v-model.number="silenceThreshold"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>
          <div>
            <div class="flex justify-between items-center mb-1.5">
              <span class="text-[11px] font-bold text-ink-mid">Min silence length</span>
              <span class="text-[11px] font-bold text-ink-lt tabular-nums">{{ (silenceMinLength / 10).toFixed(1) }} s</span>
            </div>
            <input type="range" min="1" max="30" v-model.number="silenceMinLength"
                   class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-accent" />
          </div>
          <button
            class="w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
            :disabled="!hasSelection"
            @click="showToast('Remove silence coming soon')"
          >
            <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Remove Silence
          </button>
        </div>
      </div>

      <div class="text-[11px] text-ink-mid font-bold bg-yellow-lt border-2 border-yellow rounded-[var(--radius-md)] px-3 py-2.5 text-center leading-relaxed transition-opacity duration-700"
           :class="hasSelection ? 'opacity-0' : 'opacity-100'">
        Make a selection on the waveform to apply effects
      </div>

    </div>
  </div>
</template>
