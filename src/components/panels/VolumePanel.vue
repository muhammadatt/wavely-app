<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import BaseButton from '../ui/BaseButton.vue'
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
  <div class="font-['Inter']">
    <!-- Header lives in EditPanel, which owns the Trim/Silence/Fade/Volume group -->
    <!-- Body -->
    <div class="px-4 py-4 flex flex-col gap-4">

      <!-- dB slider -->
      <div class="rounded-[12px] p-[14px]" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07)">
        <div class="flex items-center justify-between mb-2">
          <label class="font-['JetBrains_Mono'] text-[8.5px] font-bold tracking-[.14em] text-[rgba(255,255,255,.4)] uppercase">Gain</label>
          <div class="flex items-center gap-1">
            <span
              class="font-['JetBrains_Mono'] text-[15px] font-bold tabular-nums"
              :style="{ color: gainDb > 0 ? '#5df0b0' : gainDb < 0 ? '#ff8a80' : 'rgba(255,255,255,.5)' }"
            >{{ gainDb >= 0 ? '+' : '' }}{{ gainDisplay }}</span>
            <span class="text-[10px] font-semibold text-[rgba(255,255,255,.4)]">dB</span>
          </div>
        </div>
        <input
          type="range" min="-30" max="30" step="0.5"
          v-model.number="gainDb"
          @input="onGainInput"
          class="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style="background:rgba(255,255,255,.1);accent-color:#35d3e6"
        />
        <div class="flex justify-between mt-1 text-[10px] font-semibold text-[rgba(255,255,255,.35)]">
          <span>-30 dB</span>
          <span>0</span>
          <span>+30 dB</span>
        </div>
      </div>

      <!-- Quick presets -->
      <div>
        <div class="text-[11px] font-semibold text-[rgba(255,255,255,.4)] mb-2">Quick presets</div>
        <div class="flex flex-wrap gap-[6px]">
          <button
            v-for="preset in [-12, -6, -3, 3, 6, 12]"
            :key="preset"
            class="px-[10px] py-1 rounded-full text-[11px] font-bold border cursor-pointer transition-colors"
            :style="gainDb === preset
              ? 'background:#35d3e6;color:#08161a;border-color:#35d3e6'
              : 'background:rgba(255,255,255,.03);color:rgba(255,255,255,.5);border-color:rgba(255,255,255,.09)'"
            @click="gainDb = preset; onGainInput()"
          >
            {{ preset > 0 ? '+' : '' }}{{ preset }} dB
          </button>
        </div>
      </div>



      <!-- Apply button -->
      <BaseButton
        size="lg" block
        :disabled="!hasSelection || gainDb === 0"
        @click="applyVolume"
      >
        <svg viewBox="0 0 24 24" class="w-[13px] h-[13px] fill-none stroke-current" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        Apply Volume Change
      </BaseButton>

      <!-- No-selection warning -->
      <div class="text-[11px] font-semibold rounded-[12px] px-3 py-[10px] text-center leading-relaxed transition-opacity duration-700"
           style="color:#e0b84a;background:rgba(224,184,74,.08);border:1px solid rgba(224,184,74,.32)"
           :class="hasSelection ? 'opacity-0' : 'opacity-100'">
        Make a selection on the waveform to apply
      </div>
    </div>
  </div>
</template>
