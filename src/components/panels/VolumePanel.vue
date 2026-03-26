<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { adjustVolumeRegion, computePeakCache } from '../../audio/processing.js'

const {
  state, hasSelection, getAudioContext, replaceRegion, setPeakCache,
  startProcessing, endProcessing, showToast,
} = useEditorState()

const gainDb = ref(0)

const gainDisplay = ref('0.0')

function onGainInput() {
  gainDisplay.value = gainDb.value.toFixed(1)
}

async function applyVolume() {
  if (!hasSelection.value) return
  const { start, end } = state.selection

  startProcessing('Adjusting volume...')
  try {
    const ctx = getAudioContext()
    const buffer = await adjustVolumeRegion(
      state.segments, start, end, gainDb.value,
      ctx, state.currentFile.sampleRate, state.currentFile.channels
    )
    const bufferId = replaceRegion(start, end, buffer)

    const cache = await computePeakCache(buffer, 256)
    setPeakCache(bufferId, cache)

    showToast(`Volume adjusted by ${gainDb.value >= 0 ? '+' : ''}${gainDb.value.toFixed(1)} dB`)
  } catch (err) {
    console.error('Volume adjust failed:', err)
    showToast('Volume adjustment failed')
  } finally {
    endProcessing()
  }
}
</script>

<template>
  <div>
    <!-- Header -->
    <div class="px-4 pt-[18px] pb-[14px] border-b-2 border-border">
      <div class="font-heading text-[17px] font-black text-ink mb-[3px]">Volume</div>
      <div class="text-[11px] text-ink-lt font-bold">Adjust the volume of the selected region</div>
    </div>

    <!-- Body -->
    <div class="px-4 py-4 flex flex-col gap-4">

      <!-- dB slider -->
      <div>
        <div class="flex items-center justify-between mb-2">
          <label class="text-[11px] text-ink-mid font-extrabold uppercase tracking-[0.6px]">Gain</label>
          <div class="flex items-center gap-1">
            <span
              class="font-heading text-[15px] font-black tabular-nums"
              :class="gainDb > 0 ? 'text-mint' : gainDb < 0 ? 'text-accent' : 'text-ink-mid'"
            >{{ gainDb >= 0 ? '+' : '' }}{{ gainDisplay }}</span>
            <span class="text-[10px] text-ink-lt font-bold">dB</span>
          </div>
        </div>
        <input
          type="range" min="-30" max="30" step="0.5"
          v-model.number="gainDb"
          @input="onGainInput"
          class="w-full h-1.5 rounded-full appearance-none bg-border cursor-pointer accent-purple"
        />
        <div class="flex justify-between mt-1 text-[10px] text-ink-lt font-bold">
          <span>-30 dB</span>
          <span>0</span>
          <span>+30 dB</span>
        </div>
      </div>

      <!-- Quick presets -->
      <div>
        <div class="text-[11px] text-ink-mid font-extrabold uppercase tracking-[0.6px] mb-2">Quick presets</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="preset in [-12, -6, -3, 3, 6, 12]"
            :key="preset"
            class="px-2.5 py-1 rounded-[var(--radius-pill)] text-[11px] font-extrabold font-heading border-2 cursor-pointer transition-colors"
            :class="gainDb === preset
              ? 'bg-purple text-white border-purple'
              : 'bg-bg text-ink-mid border-border hover:border-purple-lt hover:text-purple'"
            @click="gainDb = preset; onGainInput()"
          >
            {{ preset > 0 ? '+' : '' }}{{ preset }} dB
          </button>
        </div>
      </div>

      <!-- No-selection warning -->
      <div v-if="!hasSelection" class="text-[11px] text-ink-mid font-bold bg-yellow-lt border-2 border-yellow rounded-[var(--radius-md)] px-3 py-2.5 text-center leading-relaxed">
        Make a selection on the waveform first
      </div>

      <!-- Apply button -->
      <button
        class="w-full flex items-center justify-center gap-1.5 bg-accent text-white font-heading text-[13px] font-extrabold py-2.5 rounded-[var(--radius-pill)] border-none cursor-pointer transition-all shadow-[0_3px_0_var(--color-accent-dk)] hover:-translate-y-0.5 hover:shadow-[0_5px_0_var(--color-accent-dk),var(--shadow-accent)] active:translate-y-[1px] active:shadow-[0_1px_0_var(--color-accent-dk)] disabled:opacity-45 disabled:cursor-default disabled:translate-y-0 disabled:shadow-none"
        :disabled="!hasSelection || gainDb === 0"
        @click="applyVolume"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Volume Change
      </button>
    </div>
  </div>
</template>

