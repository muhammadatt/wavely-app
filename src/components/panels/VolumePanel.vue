<script setup>
import { ref } from 'vue'
import { useEditorState } from '../../composables/useEditorState.js'
import { useVolume } from '../../composables/useVolume.js'
import ApplyAction from '../ui/ApplyAction.vue'

const { state, hasSelection } = useEditorState()
const { gainDb, apply: applyVolume } = useVolume()

const gainDisplay = ref('0.0')

function onGainInput() {
  gainDisplay.value = gainDb.value.toFixed(1)
}
</script>

<template>
  <div class="font-['Inter']">
    <!-- Header lives in ContextPanel, which renders it from the registry entry -->
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
      <ApplyAction
        class="mt-1"
        :met="hasSelection"
        message="Make a selection to apply"
        label="Apply Volume Change"
        :disabled="gainDb === 0 || !!state.isProcessing"
        @apply="applyVolume"
      />

    </div>
  </div>
</template>
